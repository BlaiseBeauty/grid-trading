'use strict';

// The bus (and therefore the DB pool) is loaded lazily so the pure helpers below can be
// unit-tested without a database.
let _bus = null;
function getBus() {
  if (!_bus) _bus = require('./intelligence-bus');
  return _bus;
}

const MULT_FLOOR = 0.5;   // resolver may never cut a position below half
const MULT_CEIL  = 1.3;   // ...nor boost above 1.3x (final clamp lives in enforceHardLimits)

function clampMult(n, fallback) {
  const v = Number.isFinite(n) ? n : fallback;
  return Math.min(MULT_CEIL, Math.max(MULT_FLOOR, v));
}

const MULT_STRUCTURAL_CONFLICT = clampMult(parseFloat(process.env.ORACLE_MULT_STRUCTURAL_CONFLICT || '0.5'), 0.5);
const MULT_STRATEGIC_CONFLICT  = clampMult(parseFloat(process.env.ORACLE_MULT_STRATEGIC_CONFLICT  || '0.6'), 0.6);
const MULT_MULTI_CONFLUENCE    = clampMult(parseFloat(process.env.ORACLE_MULT_MULTI_CONFLUENCE    || '1.3'), 1.3);
const MULT_SINGLE_CONFLUENCE   = clampMult(parseFloat(process.env.ORACLE_MULT_SINGLE_CONFLUENCE   || '1.15'), 1.15);

/**
 * Map any direction vocabulary to 'bull' | 'bear' | null.
 * bullish/long/buy/bull => bull ; bearish/short/sell/bear => bear.
 */
function toBullBear(d) {
  const s = String(d == null ? '' : d).trim().toLowerCase();
  if (s === 'bull' || s === 'bullish' || s === 'long' || s === 'buy') return 'bull';
  if (s === 'bear' || s === 'bearish' || s === 'short' || s === 'sell') return 'bear';
  return null;
}

/**
 * Pure: derive the size multiplier + flags from a list of theses and a proposal.
 * Returns null when the proposal direction is unrecognised (no adjustment is made).
 */
function computeResolution(theses, proposal) {
  const proposalDir = toBullBear(proposal.direction);
  if (!proposalDir) return null;

  const confluences = theses.filter(t =>
    toBullBear(t.direction) === proposalDir && parseFloat(t.conviction) >= 6.0
  );

  const conflicts = theses.filter(t => {
    const tDir = toBullBear(t.direction);
    // Only flag as conflict if: opposing direction AND same time horizon
    const opposingDir = tDir !== null && tDir !== proposalDir;
    const sameHorizon = t.time_horizon === 'strategic' && proposal.time_horizon === 'strategic';
    // Tactical GRID signals (4h) only conflict with structural theses (months-years) at very high conviction
    const structuralConflict = t.time_horizon === 'structural' && parseFloat(t.conviction) >= 8.5;
    return opposingDir && (sameHorizon || structuralConflict) && parseFloat(t.conviction) >= 7.0;
  });

  let multiplier = 1.0;
  let conflictFlag = null;
  let confluenceFlag = null;

  if (conflicts.length > 0) {
    const topConflict = [...conflicts].sort((a, b) =>
      parseFloat(b.conviction) - parseFloat(a.conviction)
    )[0];

    if (topConflict.time_horizon === 'structural' && parseFloat(topConflict.conviction) >= 9.0) {
      multiplier = MULT_STRUCTURAL_CONFLICT;
      conflictFlag = {
        thesis_id:   topConflict.payload?.thesis_id,
        thesis_name: topConflict.payload?.name,
        conviction:  topConflict.conviction,
        reason:      `ORACLE structural thesis opposes this direction at conviction ${topConflict.conviction}`,
      };
    } else if (topConflict.time_horizon === 'strategic') {
      multiplier = MULT_STRATEGIC_CONFLICT;
      conflictFlag = {
        thesis_id:   topConflict.payload?.thesis_id,
        thesis_name: topConflict.payload?.name,
        conviction:  topConflict.conviction,
        reason:      `ORACLE strategic thesis opposes this direction`,
      };
    }
  }

  if (confluences.length >= 2) {
    if (multiplier >= 1.0) {
      multiplier = MULT_MULTI_CONFLUENCE;
      confluenceFlag = {
        count: confluences.length,
        theses: confluences.map(t => t.payload?.name || t.payload?.thesis_id),
      };
    }
  } else if (confluences.length === 1 && parseFloat(confluences[0].conviction) >= 8.0) {
    if (multiplier >= 1.0) {
      multiplier = MULT_SINGLE_CONFLUENCE;
      confluenceFlag = {
        count: 1,
        theses: [confluences[0].payload?.name],
      };
    }
  }

  return { multiplier: clampMult(multiplier, 1.0), conflictFlag, confluenceFlag };
}

/**
 * Apply a resolver multiplier to a size without ever exceeding maxSizePct.
 * Reductions always apply in full; boosts are capped at maxSizePct (and never reduce
 * a size that is already at/over the cap — enforceHardLimits clamps that separately).
 */
function applySizeMultiplier(sizePct, multiplier, maxSizePct) {
  const base = Number(sizePct);
  if (!Number.isFinite(base) || base <= 0) return base;
  const m = clampMult(Number(multiplier), 1.0);
  let out = base * m;
  if (m > 1 && Number.isFinite(maxSizePct)) out = Math.min(out, Math.max(maxSizePct, base));
  return Math.round(out * 100) / 100;
}

/**
 * Apply ORACLE thesis context to a GRID trade proposal.
 * Modifies size_multiplier and adds conflict metadata.
 * Never blocks a trade — only adjusts sizing (the caller applies the multiplier through
 * applySizeMultiplier and then enforceHardLimits).
 *
 * @param {object} proposal - GRID trade proposal
 * @param {object} [deps]   - { getTheses(symbol) } injectable for tests
 * @returns {object} modified proposal
 */
async function resolveProposal(proposal, deps = {}) {
  try {
    // Oracle stores affected_assets as bare tickers ('BTC'); GRID symbols look like 'BTC/USDT'
    const baseSymbol = String(proposal.symbol || '').split('/')[0];
    const getTheses = deps.getTheses || ((sym) => getBus().getActiveThesesForSymbol(sym));
    const full = await getTheses(String(proposal.symbol || ''));
    const bare = baseSymbol && baseSymbol !== proposal.symbol ? await getTheses(baseSymbol) : [];
    const seen = new Set();
    const theses = [...(full || []), ...(bare || [])].filter(t => {
      const key = t.id != null ? t.id : JSON.stringify(t);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!theses.length) return proposal; // no oracle context — pass through

    const res = computeResolution(theses, proposal);
    if (!res) return proposal;

    proposal.size_multiplier       = res.multiplier;
    proposal.oracle_conflict       = res.conflictFlag;
    proposal.oracle_confluence     = res.confluenceFlag;
    proposal.oracle_theses_checked = theses.length;

    if (res.conflictFlag) {
      console.log(`[CONFLICT-RESOLVER] ${proposal.symbol} ${proposal.direction}: ` +
        `conflict with "${res.conflictFlag.thesis_name}" → size ×${res.multiplier}`);
    }
    if (res.confluenceFlag) {
      console.log(`[CONFLICT-RESOLVER] ${proposal.symbol} ${proposal.direction}: ` +
        `${res.confluenceFlag.count} confluent theses → size ×${res.multiplier}`);
    }
  } catch (err) {
    console.warn('[CONFLICT-RESOLVER] Failed (non-critical):', err.message);
    // Return proposal unmodified — never block on resolver failure
  }

  return proposal;
}

module.exports = {
  resolveProposal,
  computeResolution,
  applySizeMultiplier,
  toBullBear,
  MULT_FLOOR,
  MULT_CEIL,
};
