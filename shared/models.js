'use strict';

/**
 * Single source of truth for Claude model ids and token pricing.
 *
 * Every agent imports its model id from here; each id can be overridden by an
 * env var (MODEL_<KEY>) without a code change. Pricing lives in ONE table and is
 * used by shared/ai-costs.js (and should be used by any other cost calculation).
 *
 * !! PRICING VALUES MUST BE VERIFIED against current Anthropic pricing by the
 * !! operator. They are best-effort defaults. Unknown models are priced at the
 * !! most expensive tier so budget gates fail safe (over-estimate, not under).
 */

function envStr(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

// ── MODEL IDS ────────────────────────────────────────────────────────────────
const MODELS = {
  // GRID
  grid_knowledge:   envStr('MODEL_GRID_KNOWLEDGE',   'claude-sonnet-4-6'),
  grid_synthesizer: envStr('MODEL_GRID_SYNTHESIZER', 'claude-opus-4-6'),
  grid_strategy:    envStr('MODEL_GRID_STRATEGY',    'claude-sonnet-4-6'), // risk manager, regime classifier
  grid_analysis:    envStr('MODEL_GRID_ANALYSIS',    'claude-sonnet-4-6'), // performance analyst, pattern discovery
  grid_explainer:   envStr('MODEL_GRID_EXPLAINER',   'claude-haiku-4-5-20251001'),
  // ORACLE
  oracle_domain:    envStr('MODEL_ORACLE_DOMAIN',    'claude-sonnet-4-5'),
  oracle_synthesis: envStr('MODEL_ORACLE_SYNTHESIS', 'claude-opus-4-5'),
  oracle_auditor:   envStr('MODEL_ORACLE_AUDITOR',   'claude-opus-4-5'),
  // COMPASS — MODEL_COMPASS sets both; the specific vars win when set.
  compass_portfolio: envStr('MODEL_COMPASS_PORTFOLIO', envStr('MODEL_COMPASS', 'claude-sonnet-4-6')),
  compass_risk:      envStr('MODEL_COMPASS_RISK',      envStr('MODEL_COMPASS', 'claude-sonnet-4-6')),
};

// ── PRICING (USD per 1M tokens) ──────────────────────────────────────────────
// Matched by longest id prefix, so dated ids ('claude-haiku-4-5-20251001') resolve.
// VERIFY BEFORE RELYING ON THESE NUMBERS.
const PRICING_TABLE = {
  'claude-opus-4-6':   { input: 15.00, output: 75.00 },
  'claude-opus-4-5':   { input: 5.00,  output: 25.00 },
  'claude-opus-4':     { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-5': { input: 3.00,  output: 15.00 },
  'claude-sonnet-4':   { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':  { input: 1.00,  output: 5.00 },
  'claude-haiku-3-5':  { input: 0.80,  output: 4.00 },
};

// Fail-safe price for ids not in the table: the most expensive known tier.
const UNKNOWN_MODEL_PRICE = { input: 15.00, output: 75.00 };

const _warnedUnknown = new Set();

function getPricing(model) {
  const id = String(model || '');
  let bestKey = null;
  for (const key of Object.keys(PRICING_TABLE)) {
    if (id.startsWith(key) && (!bestKey || key.length > bestKey.length)) bestKey = key;
  }
  if (bestKey) return PRICING_TABLE[bestKey];
  if (!_warnedUnknown.has(id)) {
    _warnedUnknown.add(id);
    console.warn(`[MODELS] No pricing for model "${id}" — using most-expensive tier. Add it to shared/models.js.`);
  }
  return UNKNOWN_MODEL_PRICE;
}

function calculateCost(model, inputTokens, outputTokens) {
  const p = getPricing(model);
  const inTok = Number(inputTokens) || 0;
  const outTok = Number(outputTokens) || 0;
  return (inTok * p.input + outTok * p.output) / 1_000_000;
}

module.exports = { MODELS, PRICING_TABLE, UNKNOWN_MODEL_PRICE, getPricing, calculateCost };
