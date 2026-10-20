'use strict';

/**
 * Pure validation helpers for COMPASS LLM output. No DB, no network.
 * Enums mirror the CHECK constraints in db/migrations/027_compass_schema.sql.
 */

const { baseAsset } = require('../../../config/symbols');

const RISK_POSTURES = ['aggressive', 'neutral', 'defensive', 'cash'];
const DIRECTION_BIASES = ['long', 'short', 'neutral'];
const URGENCIES = ['critical', 'high', 'normal', 'low'];

// Hard caps (mirror GRID's config/risk-limits.js HARD_CAP; COMPASS may never recommend above them).
// Env can only LOWER a cap, never raise it above the hard value.
const HARD_MAX_POSITION_USD = 10000;
const HARD_MAX_TOTAL_EXPOSURE_USD = 20000;
const HARD_MAX_OPEN_POSITIONS = 6;
const MIN_SCRAM_THRESHOLD_PCT = 5.0;

function lowered(envName, hard) {
  const v = parseFloat(process.env[envName]);
  return Number.isFinite(v) && v > 0 ? Math.min(v, hard) : hard;
}

const COMPASS_LIMITS = {
  MAX_POSITION_USD: lowered('COMPASS_MAX_POSITION_USD', HARD_MAX_POSITION_USD),
  MAX_TOTAL_EXPOSURE_USD: lowered('COMPASS_MAX_TOTAL_EXPOSURE_USD', HARD_MAX_TOTAL_EXPOSURE_USD),
  MAX_OPEN_POSITIONS: HARD_MAX_OPEN_POSITIONS,
  MIN_SCRAM_THRESHOLD_PCT,
  DEFAULT_POSITION_USD: 3000,
  WEIGHT_SUM_TOLERANCE: 0.01,
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toNum = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim().slice(0, max) : '');

/**
 * Validate + normalise the portfolio agent output.
 * - risk_posture must be an allowed enum (invalid -> reject)
 * - cash_weight finite in [0,1]
 * - each weight finite and >= 0; keys canonicalised to tickers; sum(weights)+cash must be 1 +/- 0.01,
 *   otherwise weights are renormalised to (1 - cash); with no usable weights, cash must be ~1
 * - max_position_usd capped at COMPASS_LIMITS.MAX_POSITION_USD; recommended_usd <= max
 * @returns {{ok:true,result:object,warnings:string[]}|{ok:false,error:string}}
 */
function validatePortfolio(input, { trackedBases = null, postureOverride = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'portfolio output is not an object' };
  const warnings = [];

  const posture = typeof input.risk_posture === 'string' ? input.risk_posture.trim().toLowerCase() : '';
  if (!RISK_POSTURES.includes(posture)) return { ok: false, error: `invalid risk_posture "${input.risk_posture}"` };

  const cash = toNum(input.cash_weight);
  if (!isNum(cash) || cash < 0 || cash > 1) return { ok: false, error: `invalid cash_weight "${input.cash_weight}" (need finite 0..1)` };

  const rawWeights = input.recommended_weights;
  if (rawWeights !== undefined && (typeof rawWeights !== 'object' || rawWeights === null || Array.isArray(rawWeights))) {
    return { ok: false, error: 'recommended_weights is not an object' };
  }

  const weights = {};
  for (const [sym, alloc] of Object.entries(rawWeights || {})) {
    const key = baseAsset(sym);
    if (!key) { warnings.push(`dropped weight with unusable symbol "${sym}"`); continue; }
    if (trackedBases && !trackedBases.includes(key)) { warnings.push(`dropped untracked symbol "${sym}"`); continue; }
    if (!alloc || typeof alloc !== 'object') return { ok: false, error: `allocation for ${sym} is not an object` };

    const w = toNum(alloc.weight);
    if (!isNum(w) || w < 0) return { ok: false, error: `invalid weight for ${sym}: "${alloc.weight}" (need finite >= 0)` };

    const dirRaw = typeof alloc.direction === 'string' ? alloc.direction.trim().toLowerCase() : 'neutral';
    const direction = DIRECTION_BIASES.includes(dirRaw) ? dirRaw : 'neutral';
    if (dirRaw && !DIRECTION_BIASES.includes(dirRaw)) warnings.push(`${sym}: direction "${alloc.direction}" -> neutral`);

    let maxPos = toNum(alloc.max_position_usd);
    if (!isNum(maxPos) || maxPos <= 0) maxPos = COMPASS_LIMITS.DEFAULT_POSITION_USD;
    maxPos = Math.min(maxPos, COMPASS_LIMITS.MAX_POSITION_USD);

    let rec = toNum(alloc.recommended_usd);
    if (!isNum(rec) || rec < 0) rec = maxPos * 0.7;
    rec = Math.min(rec, maxPos);

    let bias = toNum(alloc.bias_conviction);
    bias = isNum(bias) && bias >= 0 && bias <= 10 ? bias : null; // 0 is a legitimate conviction

    weights[key] = {
      weight: w,
      direction,
      max_position_usd: maxPos,
      recommended_usd: rec,
      bias_conviction: bias,
      reasoning: str(alloc.reasoning, 300),
    };
  }

  // Weight-sum check: sum(weights) + cash must be 1 +/- tolerance
  const tol = COMPASS_LIMITS.WEIGHT_SUM_TOLERANCE;
  const sum = Object.values(weights).reduce((s, a) => s + a.weight, 0);
  if (Math.abs(sum + cash - 1) > tol) {
    const target = 1 - cash;
    if (sum > 0) {
      const k = target / sum;
      for (const a of Object.values(weights)) a.weight = a.weight * k;
      warnings.push(`weights summed to ${(sum + cash).toFixed(3)} incl. cash; renormalised to 1.0`);
    } else if (cash < 1 - tol) {
      return { ok: false, error: `no usable weights and cash_weight ${cash} leaves ${(1 - cash).toFixed(2)} unallocated` };
    }
  }

  // Enforce the performance-guardrail posture in CODE (the prompt override is advisory to the model)
  let finalPosture = posture;
  if (postureOverride && RISK_POSTURES.includes(postureOverride) && posture !== postureOverride) {
    warnings.push(`posture "${posture}" overridden to "${postureOverride}" by performance guardrail`);
    finalPosture = postureOverride;
  }

  const rebalance = [];
  for (const a of Array.isArray(input.rebalance_actions) ? input.rebalance_actions : []) {
    if (!a || typeof a.action !== 'string' || !a.action.trim() || typeof a.reason !== 'string') continue;
    const urg = typeof a.urgency === 'string' ? a.urgency.trim().toLowerCase() : 'normal';
    rebalance.push({
      action: str(a.action, 60),
      symbol: a.symbol ? (baseAsset(String(a.symbol)) || null) : null,
      reason: str(a.reason, 400),
      urgency: URGENCIES.includes(urg) ? urg : 'normal',
    });
  }

  return {
    ok: true,
    warnings,
    result: {
      risk_posture: finalPosture,
      posture_reasoning: str(input.posture_reasoning, 1000),
      cash_weight: cash,
      recommended_weights: weights,
      rebalance_actions: rebalance.slice(0, 10),
      key_risks: (Array.isArray(input.key_risks) ? input.key_risks : []).filter((r) => typeof r === 'string').map((r) => str(r, 200)).slice(0, 10),
    },
  };
}

/**
 * Validate + clamp the risk assessor output. risk_score must be finite 0..10 (reject otherwise —
 * the previous `|| 5` silently turned garbage and a legitimate 0 alike into a fake 5).
 * Limits are clamped to the hard constraints. @returns {{ok:true,result:object,warnings:string[]}|{ok:false,error:string}}
 */
function validateRisk(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'risk output is not an object' };
  const warnings = [];

  const score = toNum(input.risk_score);
  if (!isNum(score) || score < 0 || score > 10) return { ok: false, error: `invalid risk_score "${input.risk_score}" (need finite 0..10)` };

  const comp = {};
  for (const k of ['market_risk', 'concentration_risk', 'correlation_risk', 'drawdown_risk', 'thesis_conflict_risk']) {
    const v = toNum(input.components?.[k]);
    comp[k] = isNum(v) && v >= 0 && v <= 10 ? v : null;
  }

  const l = input.limits && typeof input.limits === 'object' ? input.limits : {};
  const num = (v, d) => { const n = toNum(v); return isNum(n) ? n : d; };
  const limits = {
    max_total_exposure_usd: Math.min(Math.max(0, num(l.max_total_exposure_usd, 15000)), COMPASS_LIMITS.MAX_TOTAL_EXPOSURE_USD),
    max_single_position_usd: Math.min(Math.max(0, num(l.max_single_position_usd, 5000)), COMPASS_LIMITS.MAX_POSITION_USD),
    max_open_positions: Math.min(Math.max(0, Math.floor(num(l.max_open_positions, 4))), COMPASS_LIMITS.MAX_OPEN_POSITIONS),
    scram_threshold_pct: Math.max(num(l.scram_threshold_pct, 8), COMPASS_LIMITS.MIN_SCRAM_THRESHOLD_PCT),
  };
  if (limits.max_single_position_usd > limits.max_total_exposure_usd) {
    limits.max_single_position_usd = limits.max_total_exposure_usd;
    warnings.push('max_single_position_usd reduced to max_total_exposure_usd');
  }

  const flags = [];
  for (const f of Array.isArray(input.flags) ? input.flags : []) {
    if (!f || typeof f.message !== 'string') continue;
    const sev = typeof f.severity === 'string' ? f.severity.toLowerCase() : 'info';
    flags.push({ severity: ['info', 'warn', 'critical'].includes(sev) ? sev : 'info', message: str(f.message, 300) });
  }

  return {
    ok: true,
    warnings,
    result: {
      risk_score: score,
      components: comp,
      limits,
      flags: flags.slice(0, 20),
      assessment_summary: str(input.assessment_summary, 800),
    },
  };
}

module.exports = {
  RISK_POSTURES, DIRECTION_BIASES, URGENCIES, COMPASS_LIMITS,
  validatePortfolio, validateRisk,
};
