'use strict';

const { query, queryOne } = require('../db/connection');

// ── TOKEN BUDGETS PER AGENT TIER ──────────────────────────────────────────────
// These are enforced at call time — agents are blocked from exceeding these.
// Prevents runaway token usage and silent truncation.
const TOKEN_BUDGETS = {
  // GRID
  grid_knowledge:    { max_input: 8000,  max_output: 4000 },
  grid_synthesizer:  { max_input: 32000, max_output: 16000 },
  grid_risk_manager: { max_input: 6000,  max_output: 4000 },
  grid_performance:  { max_input: 10000, max_output: 4000 },
  grid_pattern:      { max_input: 10000, max_output: 4000 },
  // ORACLE (future)
  oracle_domain:     { max_input: 10000, max_output: 2500 },
  oracle_synthesis:  { max_input: 15000, max_output: 4000 },
  oracle_graveyard:  { max_input: 20000, max_output: 3000 },
  // COMPASS (future)
  compass_portfolio: { max_input: 12000, max_output: 2000 },
  compass_risk:      { max_input: 8000,  max_output: 1500 },
};

// ── PRICING (USD per million tokens, as of 2025) ──────────────────────────────
// Update these if Anthropic changes pricing.
const PRICING = {
  'claude-sonnet': { input: 3.00,  output: 15.00  }, // per 1M tokens
  'claude-opus':   { input: 15.00, output: 75.00  },
  'claude-haiku':  { input: 0.25,  output: 1.25   },
};

function calculateCost(model, inputTokens, outputTokens) {
  // Match model string to pricing tier
  let tier = 'claude-sonnet'; // default
  if (model.includes('opus'))  tier = 'claude-opus';
  if (model.includes('haiku')) tier = 'claude-haiku';

  const p = PRICING[tier];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ── RECORD USAGE ──────────────────────────────────────────────────────────────

/**
 * Record a completed Claude API call.
 * Called automatically by base-agent after every API response.
 *
 * @param {object} opts
 * @param {string} opts.source_system  - 'grid' | 'compass' | 'oracle'
 * @param {string} opts.agent_name     - e.g. 'trend', 'synthesizer'
 * @param {string} opts.model          - full model string from API response
 * @param {string} [opts.cycle_id]     - links to agent_decisions cycle
 * @param {number} opts.input_tokens
 * @param {number} opts.output_tokens
 */
async function recordUsage(opts) {
  const {
    source_system, agent_name, model,
    cycle_id = null, input_tokens, output_tokens,
  } = opts;

  const cost_usd = calculateCost(model, input_tokens, output_tokens);

  try {
    await query(
      `INSERT INTO platform_ai_costs
         (source_system, agent_name, model, cycle_id,
          input_tokens, output_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [source_system, agent_name, model, cycle_id,
       input_tokens, output_tokens, cost_usd]
    );
  } catch (err) {
    // Never fail the agent call because of cost tracking
    console.error('[AI-COSTS] Failed to record usage:', err.message);
  }

  return cost_usd;
}

// ── QUERY HELPERS ─────────────────────────────────────────────────────────────

async function getMonthlySummary() {
  return queryOne(
    `SELECT
       SUM(cost_usd)       AS total_usd,
       SUM(input_tokens)   AS total_input,
       SUM(output_tokens)  AS total_output,
       COUNT(*)            AS total_calls,
       MIN(created_at)     AS period_start
     FROM platform_ai_costs
     WHERE created_at >= DATE_TRUNC('month', NOW())`
  );
}

async function getBySystem() {
  const { queryAll } = require('../db/connection');
  return queryAll(
    `SELECT
       source_system,
       SUM(cost_usd)      AS cost_usd,
       SUM(input_tokens)  AS input_tokens,
       SUM(output_tokens) AS output_tokens,
       COUNT(*)           AS calls
     FROM platform_ai_costs
     WHERE created_at >= DATE_TRUNC('month', NOW())
     GROUP BY source_system
     ORDER BY cost_usd DESC`
  );
}

async function getByAgent(sourceSystem = null) {
  const { queryAll } = require('../db/connection');
  const where = sourceSystem
    ? `WHERE source_system = '${sourceSystem}' AND created_at >= DATE_TRUNC('month', NOW())`
    : `WHERE created_at >= DATE_TRUNC('month', NOW())`;

  return queryAll(
    `SELECT
       source_system, agent_name,
       SUM(cost_usd)      AS cost_usd,
       SUM(input_tokens)  AS input_tokens,
       SUM(output_tokens) AS output_tokens,
       COUNT(*)           AS calls,
       AVG(input_tokens)  AS avg_input,
       AVG(output_tokens) AS avg_output
     FROM platform_ai_costs
     ${where}
     GROUP BY source_system, agent_name
     ORDER BY cost_usd DESC`
  );
}

async function getDailyCosts(days = 30) {
  const { queryAll } = require('../db/connection');
  return queryAll(
    `SELECT
       DATE_TRUNC('day', created_at) AS day,
       source_system,
       SUM(cost_usd) AS cost_usd,
       COUNT(*)      AS calls
     FROM platform_ai_costs
     WHERE created_at >= NOW() - INTERVAL '${days} days'
     GROUP BY DATE_TRUNC('day', created_at), source_system
     ORDER BY day DESC, cost_usd DESC`
  );
}

// ── BUDGET ENFORCEMENT ────────────────────────────────────────────────────────

/**
 * Get the token budget for an agent tier.
 * Returns default (grid_knowledge) if tier not found.
 */
function getBudget(tier) {
  return TOKEN_BUDGETS[tier] || TOKEN_BUDGETS['grid_knowledge'];
}

/**
 * Clamp a max_tokens value to the budget for an agent tier.
 * Prevents agents from requesting more output tokens than their budget allows.
 */
function clampMaxTokens(tier, requested) {
  const budget = getBudget(tier);
  if (requested > budget.max_output) {
    console.warn(
      `[AI-COSTS] ${tier} requested ${requested} output tokens, ` +
      `clamped to budget ${budget.max_output}`
    );
    return budget.max_output;
  }
  return requested;
}

module.exports = {
  TOKEN_BUDGETS,
  PRICING,
  calculateCost,
  recordUsage,
  getMonthlySummary,
  getBySystem,
  getByAgent,
  getDailyCosts,
  getBudget,
  clampMaxTokens,
};
