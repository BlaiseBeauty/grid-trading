'use strict';

// NOTE: db/connection is required lazily so pure helpers (pricing, budget gate,
// token estimation) can be unit-tested offline without creating a pg Pool.
const db = () => require('../db/connection');
const models = require('./models');

// ── TOKEN BUDGETS PER AGENT TIER ──────────────────────────────────────────────
// max_output is clamped on every call (clampMaxTokens). max_input is enforced
// before every API call by shared/llm-client.js (see fitInputToBudget).
const TOKEN_BUDGETS = {
  // GRID
  grid_knowledge:    { max_input: 8000,  max_output: 4000 },
  grid_synthesizer:  { max_input: 32000, max_output: 16000 },
  grid_risk_manager: { max_input: 6000,  max_output: 4000 },
  grid_performance:  { max_input: 10000, max_output: 8000 },
  grid_pattern:      { max_input: 10000, max_output: 8000 },
  // ORACLE
  oracle_domain:     { max_input: 10000, max_output: 2500 },
  oracle_synthesis:  { max_input: 15000, max_output: 8000 },
  oracle_graveyard:  { max_input: 20000, max_output: 3000 },
  // COMPASS
  compass_portfolio: { max_input: 12000, max_output: 2000 },
  compass_risk:      { max_input: 8000,  max_output: 1500 },
};

// ── PRICING — single table lives in shared/models.js ──────────────────────────
// PRICING kept as an export for api/platform/costs.js (shape: tier -> {input,output}).
const PRICING = {
  'claude-sonnet': models.getPricing('claude-sonnet-4-6'),
  'claude-opus':   models.getPricing('claude-opus-4-6'),
  'claude-haiku':  models.getPricing('claude-haiku-4-5'),
};

function calculateCost(model, inputTokens, outputTokens) {
  return models.calculateCost(model, inputTokens, outputTokens);
}

// ── TYPED ERRORS ──────────────────────────────────────────────────────────────

class BudgetExceededError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BudgetExceededError';
    this.code = 'AI_BUDGET_EXCEEDED';
    this.details = details;
  }
}

class InputBudgetExceededError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'InputBudgetExceededError';
    this.code = 'AI_INPUT_BUDGET_EXCEEDED';
    this.details = details;
  }
}

// ── TOKEN ESTIMATION / INPUT BUDGET ───────────────────────────────────────────

const CHARS_PER_TOKEN = 3.5;

function estimateTokens(...parts) {
  let chars = 0;
  for (const p of parts) {
    if (p == null) continue;
    chars += typeof p === 'string' ? p.length : JSON.stringify(p).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function inputBudgetMode() {
  const m = String(process.env.AI_INPUT_BUDGET_MODE || 'truncate').toLowerCase();
  return ['truncate', 'throw', 'off'].includes(m) ? m : 'truncate';
}

function inputBudgetScale() {
  const s = parseFloat(process.env.AI_INPUT_BUDGET_SCALE || '1');
  return Number.isFinite(s) && s > 0 ? s : 1;
}

// Lowest priority first: these are shrunk before anything else.
const SECTION_SHRINK_ORDER = [
  /ACTIVE LEARNINGS|MEMORY|LEARNINGS/i,
  /^=== CONTEXT ===|CONTEXT/i,
  /MARKET DATA|EVIDENCE|DATA/i,
];

/**
 * Shrink a user prompt so system+user fits max_input tokens.
 * Splits on "=== SECTION ===" markers (GRID context-builder format) and trims
 * lowest-priority sections first; the TASK section is never trimmed. For prompts
 * without section markers the tail is trimmed (head kept).
 * Pure function — returns { text, truncated, before, after }.
 */
function fitInputToBudget(system, user, maxInputTokens) {
  const before = estimateTokens(system, user);
  if (before <= maxInputTokens) return { text: user, truncated: false, before, after: before };

  const sysTokens = estimateTokens(system);
  let allowedChars = Math.max(500, Math.floor((maxInputTokens - sysTokens) * CHARS_PER_TOKEN));
  const marker = '\n[...TRUNCATED to fit token budget...]';

  const parts = String(user).split(/\n(?==== )/);
  if (parts.length < 2) {
    const text = String(user).slice(0, Math.max(0, allowedChars - marker.length)) + marker;
    return { text, truncated: true, before, after: estimateTokens(system, text) };
  }

  const isTask = (p) => /^=== TASK/i.test(p);
  const sections = parts.map((p) => ({ text: p, protected: isTask(p) }));
  let total = sections.reduce((s, x) => s + x.text.length + 1, 0);

  const rank = (s) => {
    const head = s.text.slice(0, 60);
    for (let i = 0; i < SECTION_SHRINK_ORDER.length; i++) {
      if (SECTION_SHRINK_ORDER[i].test(head)) return i;
    }
    return SECTION_SHRINK_ORDER.length;
  };
  const order = sections.filter((s) => !s.protected).sort((a, b) => rank(a) - rank(b));

  for (const s of order) {
    if (total <= allowedChars) break;
    const over = total - allowedChars;
    const minKeep = 400;
    const newLen = Math.max(minKeep, s.text.length - over - marker.length);
    if (newLen < s.text.length) {
      total -= s.text.length - (newLen + marker.length);
      s.text = s.text.slice(0, newLen) + marker;
    }
  }
  const text = sections.map((s) => s.text).join('\n');
  return { text, truncated: true, before, after: estimateTokens(system, text) };
}

// ── DAILY SPEND GATE ──────────────────────────────────────────────────────────

const SPEND_CACHE_MS = 60 * 1000;
let _spendCache = { value: 0, at: 0, valid: false };
let _spendProvider = null; // injectable for tests: async () => number

function dailyBudgetUsd() {
  const raw = process.env.AI_DAILY_BUDGET_USD;
  if (raw === undefined || raw === '') return 5;
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return 5;
  return v; // <= 0 disables the gate
}

async function querySpendToday() {
  const row = await db().queryOne(
    `SELECT COALESCE(SUM(cost_usd), 0) AS spend
     FROM platform_ai_costs
     WHERE created_at >= DATE_TRUNC('day', NOW())`
  );
  return parseFloat(row?.spend || 0);
}

async function getTodaySpend({ force = false, now = Date.now() } = {}) {
  if (!force && _spendCache.valid && now - _spendCache.at < SPEND_CACHE_MS) return _spendCache.value;
  const provider = _spendProvider || querySpendToday;
  const value = Number(await provider());
  _spendCache = { value: Number.isFinite(value) ? value : 0, at: now, valid: true };
  return _spendCache.value;
}

/**
 * Refuse a call when today's spend >= AI_DAILY_BUDGET_USD.
 * A failure to read spend fails OPEN (logged) so a DB blip cannot stop trading analysis.
 * @throws {BudgetExceededError}
 */
async function assertWithinDailyBudget({ source_system = null, agent_name = null, now } = {}) {
  const limit = dailyBudgetUsd();
  if (limit <= 0) return { limit, spend: null };
  let spend;
  try {
    spend = await getTodaySpend({ now });
  } catch (err) {
    console.error('[AI-COSTS] Could not read daily spend — failing open:', err.message);
    return { limit, spend: null };
  }
  if (spend >= limit) {
    console.error(
      `[AI-COSTS] DAILY BUDGET EXCEEDED: $${spend.toFixed(4)} >= $${limit.toFixed(2)} ` +
      `(${source_system || '?'}/${agent_name || '?'}) — call refused`
    );
    throw new BudgetExceededError(
      `Daily AI budget exceeded ($${spend.toFixed(2)} of $${limit.toFixed(2)})`,
      { spend, limit, source_system, agent_name }
    );
  }
  return { limit, spend };
}

// Test hooks
let _usageRecorder = null; // async (row) => void ; replaces the DB write in recordUsage
function _setUsageRecorder(fn) { _usageRecorder = fn; }
function _setSpendProvider(fn) { _spendProvider = fn; _spendCache = { value: 0, at: 0, valid: false }; }
function _resetSpendCache() { _spendCache = { value: 0, at: 0, valid: false }; }

// ── RECORD USAGE ──────────────────────────────────────────────────────────────

/**
 * Record ONE Claude API call (success, partial or failure) — the single write path
 * for cost data. Writes platform_ai_costs and, for GRID, the legacy system_costs
 * row in the same transaction.
 *
 * @param {object} opts
 * @param {string} opts.source_system  'grid' | 'compass' | 'oracle'
 * @param {string} opts.agent_name
 * @param {string} opts.model
 * @param {number|null} [opts.cycle_id]  integer cycle id/number (not a string)
 * @param {number} opts.input_tokens
 * @param {number} opts.output_tokens
 * @param {string} [opts.status]  'ok' | 'truncated' | 'failed'
 * @param {string} [opts.error]
 * @returns {Promise<number>} cost_usd
 */
async function recordUsage(opts) {
  const {
    source_system, agent_name, model,
    cycle_id = null, input_tokens = 0, output_tokens = 0,
    status = 'ok', error = null,
  } = opts;

  const cost_usd = calculateCost(model, input_tokens, output_tokens);
  const cycleInt = Number.isInteger(cycle_id) ? cycle_id : null;

  // Keep the in-process daily spend current between 60s cache refreshes.
  if (_spendCache.valid) _spendCache.value += cost_usd;

  if (_usageRecorder) { // test hook: no DB
    await _usageRecorder({ ...opts, cycle_id: cycleInt, cost_usd });
    return cost_usd;
  }

  try {
    await db().transaction(async (client) => {
      try {
        await client.query(
          `INSERT INTO platform_ai_costs
             (source_system, agent_name, model, cycle_id,
              input_tokens, output_tokens, cost_usd, status, error)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [source_system, agent_name, model, cycleInt,
           input_tokens, output_tokens, cost_usd, status, error ? String(error).slice(0, 500) : null]
        );
      } catch (colErr) {
        if (colErr.code !== '42703') throw colErr; // undefined_column: migration 041 not applied yet
        // The failed statement aborts the transaction; use a savepoint-free retry on a fresh tx below.
        throw Object.assign(colErr, { _legacyFallback: true });
      }
      if (source_system === 'grid') {
        await client.query(
          `INSERT INTO system_costs (service, agent_name, model, input_tokens, output_tokens, cost_usd, cycle_number)
           VALUES ('anthropic',$1,$2,$3,$4,$5,$6)`,
          [agent_name, model, input_tokens, output_tokens, cost_usd, cycleInt]
        );
      }
    });
  } catch (err) {
    if (err._legacyFallback) {
      try {
        await db().transaction(async (client) => {
          await client.query(
            `INSERT INTO platform_ai_costs
               (source_system, agent_name, model, cycle_id, input_tokens, output_tokens, cost_usd)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [source_system, agent_name, model, cycleInt, input_tokens, output_tokens, cost_usd]
          );
          if (source_system === 'grid') {
            await client.query(
              `INSERT INTO system_costs (service, agent_name, model, input_tokens, output_tokens, cost_usd, cycle_number)
               VALUES ('anthropic',$1,$2,$3,$4,$5,$6)`,
              [agent_name, model, input_tokens, output_tokens, cost_usd, cycleInt]
            );
          }
        });
      } catch (err2) {
        console.error('[AI-COSTS] Failed to record usage (legacy schema):', err2.message);
      }
    } else {
      // Never fail the agent call because of cost tracking
      console.error('[AI-COSTS] Failed to record usage:', err.message);
    }
  }

  return cost_usd;
}

// ── QUERY HELPERS ─────────────────────────────────────────────────────────────

async function getMonthlySummary() {
  return db().queryOne(
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
  return db().queryAll(
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
  const params = [];
  let where = `WHERE created_at >= DATE_TRUNC('month', NOW())`;
  if (sourceSystem) {
    params.push(String(sourceSystem));
    where = `WHERE source_system = $1 AND created_at >= DATE_TRUNC('month', NOW())`;
  }

  return db().queryAll(
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
     ORDER BY cost_usd DESC`,
    params
  );
}

async function getDailyCosts(days = 30) {
  const n = Math.max(1, Math.min(3650, parseInt(days, 10) || 30));
  return db().queryAll(
    `SELECT
       DATE_TRUNC('day', created_at) AS day,
       source_system,
       SUM(cost_usd) AS cost_usd,
       COUNT(*)      AS calls
     FROM platform_ai_costs
     WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
     GROUP BY DATE_TRUNC('day', created_at), source_system
     ORDER BY day DESC, cost_usd DESC`,
    [n]
  );
}

// ── BUDGET ENFORCEMENT ────────────────────────────────────────────────────────

/** Get the token budget for an agent tier (defaults to grid_knowledge if unknown). */
function getBudget(tier) {
  return TOKEN_BUDGETS[tier] || TOKEN_BUDGETS['grid_knowledge'];
}

/** Clamp a max_tokens value to the budget for an agent tier. */
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

/** Effective max_input for a tier after AI_INPUT_BUDGET_SCALE. */
function getMaxInputTokens(tier) {
  return Math.floor(getBudget(tier).max_input * inputBudgetScale());
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
  // input budget
  estimateTokens,
  fitInputToBudget,
  getMaxInputTokens,
  inputBudgetMode,
  // daily budget gate
  BudgetExceededError,
  InputBudgetExceededError,
  assertWithinDailyBudget,
  getTodaySpend,
  dailyBudgetUsd,
  _setSpendProvider,
  _setUsageRecorder,
  _resetSpendCache,
};
