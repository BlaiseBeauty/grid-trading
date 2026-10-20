/**
 * Risk enforcement — PURE functions (no DB, no network, no env reads unless noted).
 *
 * Design: code is the final authority on risk; the LLM only proposes.
 * Everything that can reach the execution path passes through enforceHardLimits().
 * Re-exported from strategy/risk-manager.js so callers can use either path.
 */

'use strict';

const LONG_WORDS = new Set(['long', 'buy', 'bullish', 'bull']);
const SHORT_WORDS = new Set(['short', 'sell', 'bearish', 'bear']);

// Round-trip cost (entry fee + slippage + exit fee) used for fee-adjusted R:R
const ROUND_TRIP_COST_PCT = 0.002;

/** 'long' | 'short' | null */
function normalizeDirection(d) {
  const s = String(d == null ? '' : d).trim().toLowerCase();
  if (LONG_WORDS.has(s)) return 'long';
  if (SHORT_WORDS.has(s)) return 'short';
  return null;
}

/** Finite number from number or numeric string; NaN otherwise (null/''/NaN/Infinity -> NaN). */
function toFiniteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function baseSymbol(symbol) {
  return String(symbol || '').split('/')[0].toUpperCase();
}

function floor2(n) {
  return Math.floor(n * 100 + 1e-9) / 100;
}

// ---------------------------------------------------------------------------
// Effective limits — strictest wins
// ---------------------------------------------------------------------------

function isMinType(key) {
  // MIN_* thresholds and the blackout window: larger value == stricter
  return key.startsWith('MIN_') || key === 'EVENT_BLACKOUT_HOURS';
}

/**
 * Merge limit sets so the strictest value always wins:
 *  - MAX_* numeric limits  -> Math.min
 *  - MIN_* thresholds / EVENT_BLACKOUT_HOURS -> Math.max
 *  - booleans (PAPER_ONLY, NO_NEW_POSITIONS, CLOSE_*) -> logical OR
 * Later sets can never loosen an earlier one.
 */
function mergeStrictest(base, ...overrides) {
  const out = { ...(base || {}) };
  for (const ov of overrides) {
    if (!ov) continue;
    for (const [key, val] of Object.entries(ov)) {
      if (typeof val === 'boolean') {
        out[key] = Boolean(out[key]) || val;
      } else if (typeof val === 'number' && Number.isFinite(val)) {
        if (typeof out[key] !== 'number' || !Number.isFinite(out[key])) {
          out[key] = val;
        } else {
          out[key] = isMinType(key) ? Math.max(out[key], val) : Math.min(out[key], val);
        }
      } else if (out[key] === undefined) {
        out[key] = val;
      }
    }
  }
  return out;
}

/**
 * @param {object} state  { bootstrapPhase, scramLevel }
 * @param {object} cfg    { base, bootstrap, scram } — base limits, BOOTSTRAP map, SCRAM map
 */
function computeEffectiveLimits(state, cfg) {
  const s = state || {};
  const bootstrapOverride = cfg.bootstrap ? cfg.bootstrap[s.bootstrapPhase] : null;
  const scramOverride = s.scramLevel && cfg.scram ? cfg.scram[s.scramLevel] : null;
  return mergeStrictest(cfg.base, bootstrapOverride, scramOverride);
}

// ---------------------------------------------------------------------------
// Exposure helpers
// ---------------------------------------------------------------------------

/**
 * Total correlated exposure (% of equity) if a new position of sizePct is added.
 */
function computeCorrelatedExposure({ symbol, direction, sizePct }, openTrades, correlations, equity) {
  if (!equity || equity <= 0) return 0;
  const newSymbol = baseSymbol(symbol);
  const newSign = normalizeDirection(direction) === 'short' ? -1 : 1;
  let correlatedSum = sizePct || 0;

  for (const trade of openTrades || []) {
    const tradeSymbol = baseSymbol(trade.symbol);
    if (tradeSymbol === newSymbol) continue;
    const corr = (correlations || {})[`${newSymbol}_${tradeSymbol}`] ?? (correlations || {})[`${tradeSymbol}_${newSymbol}`] ?? 0;
    if (Math.abs(corr) <= 0.5) continue;
    const entryPrice = parseFloat(trade.entry_price) || 0;
    const qty = parseFloat(trade.quantity) || 0;
    if (!entryPrice || !qty) continue;
    const existingSizePct = (entryPrice * qty / equity) * 100;
    const existingSign = trade.side === 'sell' ? -1 : 1;
    if (corr * newSign * existingSign > 0) correlatedSum += existingSizePct * Math.abs(corr);
  }
  return correlatedSum;
}

function assetClassExposurePct(openTrades, assetClass, equity) {
  if (!equity || equity <= 0) return 0;
  let sum = 0;
  for (const t of openTrades || []) {
    if ((t.asset_class || 'crypto') !== assetClass) continue;
    sum += (parseFloat(t.entry_price) || 0) * (parseFloat(t.quantity) || 0);
  }
  return (sum / equity) * 100;
}

/** First blocking high-impact event within the blackout window, or null. */
function findBlackoutEvent(events, symbol, now, hours) {
  if (!Array.isArray(events) || !(hours > 0)) return null;
  const base = baseSymbol(symbol);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  for (const ev of events) {
    const impact = String(ev.impact_estimate || '').toLowerCase();
    if (impact !== 'high' && impact !== 'critical') continue;
    const at = new Date(ev.event_date).getTime();
    if (!Number.isFinite(at)) continue;
    let start = at - hours * 3600000;
    let end = at;
    if (ev.blackout_start) { const b = new Date(ev.blackout_start).getTime(); if (Number.isFinite(b)) start = Math.min(start, b); }
    if (ev.blackout_end) { const b = new Date(ev.blackout_end).getTime(); if (Number.isFinite(b)) end = Math.max(end, b); }
    if (nowMs < start || nowMs > end) continue;
    const assets = ev.affected_assets;
    if (Array.isArray(assets) && assets.length > 0) {
      const set = assets.map(a => String(a).toUpperCase());
      if (!(set.includes(base) || set.includes('ALL') || set.includes('*') || set.includes('CRYPTO'))) continue;
    }
    return ev;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The single hard-limit gate
// ---------------------------------------------------------------------------

/**
 * Enforce hard limits on a proposal. Never trusts LLM-supplied levels: callers must pass the
 * trusted proposal (original sl/tp/entry/mode/exploration) with only a size attached.
 *
 * @param {object} proposal  { symbol, direction, confidence, entry_price, sl_price, tp_price,
 *                             approved_size_pct | position_size_suggestion_pct, exploration, asset_class }
 * @param {object} state     { equity, openPositions, openTrades, dailyLossPct, scramLevel,
 *                             correlations, upcomingEvents, eventsError, now }
 * @param {object} limits    effective limits (computeEffectiveLimits output)
 * @param {object} opts      { mode: 'live'|'paper', compassMaxPct, minRiskReward }
 * @returns {{ok: boolean, reasons: string[], adjustments: string[], proposal: object|null}}
 */
function enforceHardLimits(proposal, state, limits, opts = {}) {
  const st = state || {};
  const lim = limits || {};
  const reasons = [];
  const adjustments = [];
  const fail = () => ({ ok: false, reasons, adjustments, proposal: null });
  const p = proposal || {};

  // --- structural validity -------------------------------------------------
  if (typeof p.symbol !== 'string' || p.symbol.trim() === '') reasons.push('invalid_symbol');
  const dir = normalizeDirection(p.direction);
  if (!dir) reasons.push('invalid_direction');

  const confidence = toFiniteNumber(p.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) reasons.push('invalid_confidence');

  const entry = toFiniteNumber(p.entry_price);
  const sl = toFiniteNumber(p.sl_price);
  const tp = toFiniteNumber(p.tp_price);
  if (!(entry > 0)) reasons.push('invalid_entry_price');
  if (!(sl > 0)) reasons.push('missing_stop_loss');
  if (!(tp > 0)) reasons.push('missing_take_profit');

  const equity = toFiniteNumber(st.equity);
  if (!(equity > 0)) reasons.push('risk_check_unavailable (equity)');

  const requested = toFiniteNumber(p.approved_size_pct != null ? p.approved_size_pct : p.position_size_suggestion_pct);
  if (!(requested > 0)) reasons.push('invalid_position_size');

  if (reasons.length > 0) return fail();

  // --- stop / target geometry (signed distances) -----------------------------
  const sign = dir === 'long' ? 1 : -1;
  const riskDist = sign * (entry - sl);     // > 0 when stop is on the losing side
  const rewardDist = sign * (tp - entry);   // > 0 when target is on the winning side
  if (!(riskDist > 0)) reasons.push(`stop_wrong_side (${dir} entry=${entry} sl=${sl})`);
  if (!(rewardDist > 0)) reasons.push(`target_wrong_side (${dir} entry=${entry} tp=${tp})`);
  if (reasons.length > 0) return fail();

  const minRR = opts.minRiskReward ?? lim.MIN_RISK_REWARD_RATIO;
  if (Number.isFinite(minRR)) {
    const rr = (rewardDist - entry * ROUND_TRIP_COST_PCT) / riskDist;
    if (rr < minRR) reasons.push(`low_risk_reward (fee-adjusted R:R ${rr.toFixed(2)} < ${minRR})`);
  }
  const stopPct = (riskDist / entry) * 100;

  // --- state-level gates ------------------------------------------------------
  const scram = st.scramLevel;
  if (lim.NO_NEW_POSITIONS || scram === 'crisis' || scram === 'emergency') {
    reasons.push(`scram_active (${scram || 'no_new_positions'})`);
  }
  if (Number.isFinite(lim.MAX_OPEN_POSITIONS) && (st.openPositions || 0) >= lim.MAX_OPEN_POSITIONS) {
    reasons.push(`max_positions_reached (${st.openPositions || 0}/${lim.MAX_OPEN_POSITIONS})`);
  }
  if (Number.isFinite(lim.MAX_DAILY_LOSS_PCT) && (st.dailyLossPct || 0) >= lim.MAX_DAILY_LOSS_PCT) {
    reasons.push(`daily_loss_limit (${(st.dailyLossPct || 0).toFixed(1)}% >= ${lim.MAX_DAILY_LOSS_PCT}%)`);
  }

  const isExploration = p.exploration === true;
  const confThreshold = isExploration ? 40 : lim.MIN_CONFIDENCE_TO_TRADE;
  if (Number.isFinite(confThreshold) && confidence < confThreshold) {
    reasons.push(`low_confidence (${confidence} < ${confThreshold}${isExploration ? ' exploration' : ''})`);
  }

  const mode = opts.mode === 'live' ? 'live' : 'paper';
  if (lim.PAPER_ONLY && mode === 'live') reasons.push('bootstrap_paper_only');

  if (st.eventsError && mode === 'live') {
    reasons.push('risk_check_unavailable (events_calendar)');
  } else {
    const ev = findBlackoutEvent(st.upcomingEvents, p.symbol, st.now || new Date(), lim.EVENT_BLACKOUT_HOURS);
    if (ev) reasons.push(`event_blackout (${ev.event_name || ev.event_type} @ ${new Date(ev.event_date).toISOString()})`);
  }

  // --- sizing: clamp AFTER any multiplier, to every ceiling -------------------
  const assetClass = p.asset_class || 'crypto';
  const ceilings = [];
  if (Number.isFinite(lim.MAX_SINGLE_POSITION_PCT)) ceilings.push(['max_single_position', lim.MAX_SINGLE_POSITION_PCT]);
  if (Number.isFinite(opts.compassMaxPct)) ceilings.push(['compass_cap', opts.compassMaxPct]);
  if (Number.isFinite(lim.MAX_SINGLE_TRADE_LOSS_PCT)) {
    ceilings.push(['max_single_trade_loss', (lim.MAX_SINGLE_TRADE_LOSS_PCT * 100) / stopPct]);
  }
  if (Number.isFinite(lim.MAX_ASSET_CLASS_EXPOSURE_PCT)) {
    const headroom = lim.MAX_ASSET_CLASS_EXPOSURE_PCT - assetClassExposurePct(st.openTrades, assetClass, equity);
    ceilings.push(['asset_class_exposure', headroom]);
  }

  let ceiling = Infinity;
  let binding = null;
  for (const [name, value] of ceilings) {
    if (value < ceiling) { ceiling = value; binding = name; }
  }

  // MIN_POSITION_PCT can never exceed the single-position cap (e.g. infant 2% < paper min 3%)
  let minPos = Number.isFinite(lim.MIN_POSITION_PCT) ? lim.MIN_POSITION_PCT : 0;
  if (Number.isFinite(lim.MAX_SINGLE_POSITION_PCT)) minPos = Math.min(minPos, lim.MAX_SINGLE_POSITION_PCT);

  let size = requested;
  if (size < minPos) {
    adjustments.push(`size ${size}% raised to MIN_POSITION_PCT ${minPos}%`);
    size = minPos;
  }
  if (size > ceiling) {
    adjustments.push(`size ${size}% clamped to ${floor2(Math.max(ceiling, 0))}% (${binding})`);
    size = ceiling;
  }
  size = floor2(size);
  if (!(size > 0) || size < minPos - 1e-9) {
    reasons.push(`below_min_position (${size}% < ${minPos}% after ${binding || 'caps'} ceiling ${Number.isFinite(ceiling) ? floor2(Math.max(ceiling, 0)) : 'none'}%)`);
  }

  // --- correlated exposure uses the FINAL size --------------------------------
  if (Number.isFinite(lim.MAX_CORRELATED_EXPOSURE_PCT) && st.correlations) {
    const corrExposure = computeCorrelatedExposure(
      { symbol: p.symbol, direction: dir, sizePct: size }, st.openTrades, st.correlations, equity
    );
    if (corrExposure > lim.MAX_CORRELATED_EXPOSURE_PCT) {
      reasons.push(`correlated_exposure_limit (${corrExposure.toFixed(1)}% > ${lim.MAX_CORRELATED_EXPOSURE_PCT}%)`);
    }
  }

  if (reasons.length > 0) return fail();

  return {
    ok: true,
    reasons,
    adjustments,
    proposal: {
      ...p,
      direction: dir,
      confidence,
      entry_price: entry,
      sl_price: sl,
      tp_price: tp,
      exploration: isExploration,
      mode,
      approved_size_pct: size,
      stop_distance_pct: Math.round(stopPct * 1000) / 1000,
      risk_pct_of_equity: Math.round(size * stopPct) / 100,
      hard_limit_adjustments: adjustments,
    },
  };
}

// ---------------------------------------------------------------------------
// LLM decision merge — the model may only approve/reject/resize preflight-passed proposals
// ---------------------------------------------------------------------------

/**
 * @param {object} assessment  parsed LLM output_json
 * @param {object[]} passed    proposals that survived code pre-flight (trusted source of levels)
 * @returns {{approved: object[], rejected: object[], dropped: object[]}}
 */
function mergeRiskDecisions(assessment, passed) {
  const a = assessment || {};
  const approved = [];
  const rejected = [];
  const dropped = [];
  const used = new Set();

  if (Array.isArray(a.decisions)) {
    for (const dec of a.decisions) {
      const decDir = dec && dec.direction != null ? normalizeDirection(dec.direction) : null;
      const matches = passed.filter(p =>
        p.symbol === dec?.symbol && (dec.direction == null || normalizeDirection(p.direction) === decDir)
      );
      if (matches.length !== 1) {
        dropped.push({ decision: dec, reason: matches.length === 0 ? 'unknown_symbol_or_direction' : 'ambiguous_match' });
        continue;
      }
      const proposal = matches[0];
      if (used.has(proposal)) { dropped.push({ decision: dec, reason: 'duplicate_decision' }); continue; }
      used.add(proposal);

      if (dec.action === 'approve' || dec.action === 'modify') {
        const mods = dec.modifications || {};
        const llmSize = toFiniteNumber(dec.position_size_pct != null ? dec.position_size_pct : mods.position_size_pct);
        approved.push({
          ...proposal,
          approved_size_pct: llmSize > 0 ? llmSize : proposal.position_size_suggestion_pct,
          risk_notes: dec.risk_notes || null,
        });
      } else {
        rejected.push({
          ...proposal,
          reason: dec.rejection_reason || 'risk_manager_rejected',
          detail: dec.risk_notes || null,
        });
      }
    }
  } else if (a.decision && !a.approved) {
    if (a.decision === 'approve' || a.decision === 'modify') {
      const llmSize = toFiniteNumber((a.modifications || {}).position_size_pct);
      for (const p of passed) {
        approved.push({
          ...p,
          approved_size_pct: llmSize > 0 ? llmSize : p.position_size_suggestion_pct,
          risk_notes: Array.isArray(a.warnings) ? a.warnings.join('; ') : null,
        });
      }
    } else {
      for (const p of passed) {
        rejected.push({
          ...p,
          reason: a.risk_assessment?.reason || 'risk_manager_rejected',
          detail: Array.isArray(a.warnings) ? a.warnings.join('; ') : undefined,
        });
      }
    }
  } else {
    // No recognised decision format. Direct approved/rejected arrays are NOT trusted.
    for (const p of passed) {
      rejected.push({ ...p, reason: 'risk_manager_no_valid_decision', detail: 'unrecognised risk manager output' });
    }
  }

  return { approved, rejected, dropped };
}

module.exports = {
  ROUND_TRIP_COST_PCT,
  normalizeDirection,
  toFiniteNumber,
  mergeStrictest,
  computeEffectiveLimits,
  computeCorrelatedExposure,
  assetClassExposurePct,
  findBlackoutEvent,
  enforceHardLimits,
  mergeRiskDecisions,
};
