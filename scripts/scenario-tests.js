'use strict';

/**
 * GRID Scenario Tests — Trading Logic Correctness
 *
 * Tests the key decision logic WITHOUT a DB connection.
 * Mirrors the exact logic in portfolio-agent.js and risk-manager.js.
 * Run with: node scripts/scenario-tests.js
 *
 * When to run: after any change to risk-manager.js, portfolio-agent.js,
 *              risk-limits.js, or compass posture logic.
 */

// ─── Pure logic simulations (mirrors real agent logic) ────────────────────────

/**
 * Simulate portfolio-agent.js posture override decision.
 * Mirrors the guardrails block (lines 83-107 in portfolio-agent.js).
 */
function simulatePostureOverride({ drawdownPct, winRate, totalTrades, regime }) {
  if (totalTrades < 5) return { override: null, reason: 'insufficient_samples (<5 trades)' };

  if (drawdownPct >= 8.0) {
    if (regime === 'trending_up') {
      return { override: 'defensive', reason: `drawdown ${drawdownPct}% >= 8% but regime BULLISH → DEFENSIVE (regime override)` };
    }
    return { override: 'cash', reason: `drawdown ${drawdownPct}% >= 8%, regime=${regime || 'unknown'} → CASH` };
  }

  if (drawdownPct >= 5.0 || winRate < 40) {
    return { override: 'defensive', reason: `weak performance (drawdown=${drawdownPct}%, winRate=${winRate}%) → DEFENSIVE` };
  }

  return { override: null, reason: 'within normal thresholds — Claude decides' };
}

/**
 * Simulate risk-manager.js preflightCheck for a single proposal.
 * Mirrors the per-proposal block (lines 214-293 in risk-manager.js).
 */
function simulatePreflight({ proposal: rawProposal, compassPosture, state, limits }) {
  const proposal = { ...rawProposal }; // don't mutate input
  const reasons = [];

  const defaults = {
    MAX_OPEN_POSITIONS: 8,
    MAX_DAILY_LOSS_PCT: 3,
    MIN_CONFIDENCE_TO_TRADE: 70,
    MAX_DRAWDOWN_PCT: 10,
    MIN_SIGNAL_COMPLEXITY: 2,
  };
  const L = { ...defaults, ...limits };

  // Drawdown hard stop (runs before per-proposal checks in real code)
  if ((state.drawdownPct || 0) >= L.MAX_DRAWDOWN_PCT) {
    return { result: 'rejected', reasons: [`max_drawdown_exceeded (${state.drawdownPct}% >= ${L.MAX_DRAWDOWN_PCT}%)`], proposal };
  }

  // SCRAM
  if (state.scramLevel === 'crisis' || state.scramLevel === 'emergency') {
    return { result: 'rejected', reasons: [`scram_active (${state.scramLevel})`], proposal };
  }

  // COMPASS posture — CASH = hard ban on longs, DEFENSIVE = halve size
  if (compassPosture?.risk_posture === 'CASH') {
    const isLong = proposal.direction === 'long' || proposal.direction === 'bullish';
    if (isLong) {
      reasons.push(`CASH posture — long trades banned`);
    }
  } else if (compassPosture?.risk_posture === 'DEFENSIVE') {
    const isLong = proposal.direction === 'long' || proposal.direction === 'bullish';
    if (isLong) {
      proposal.position_size_suggestion_pct = Math.max(
        1,
        Math.round((proposal.position_size_suggestion_pct || 5) * 0.5 * 100) / 100
      );
      // Note: size is reduced but proposal is NOT rejected — falls through
    }
  }

  // Max open positions
  if ((state.openPositions || 0) >= L.MAX_OPEN_POSITIONS) {
    reasons.push(`max_positions_reached (${state.openPositions}/${L.MAX_OPEN_POSITIONS})`);
  }

  // Daily loss limit
  if ((state.dailyLossPct || 0) >= L.MAX_DAILY_LOSS_PCT) {
    reasons.push(`daily_loss_limit (${state.dailyLossPct}% >= ${L.MAX_DAILY_LOSS_PCT}%)`);
  }

  // Min confidence
  if ((proposal.confidence || 0) < L.MIN_CONFIDENCE_TO_TRADE) {
    reasons.push(`low_confidence (${proposal.confidence} < ${L.MIN_CONFIDENCE_TO_TRADE})`);
  }

  // Min complexity
  if ((proposal.complexity_score || 0) < L.MIN_SIGNAL_COMPLEXITY) {
    reasons.push(`low_complexity (${proposal.complexity_score || 0} < ${L.MIN_SIGNAL_COMPLEXITY})`);
  }

  if (reasons.length > 0) {
    return { result: 'rejected', reasons, proposal };
  }
  return { result: 'passed', proposal };
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`      → ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected "${expected}", got "${actual}"`);
  }
}

// ─── POSTURE OVERRIDE SCENARIOS ───────────────────────────────────────────────

console.log('\n═══ POSTURE OVERRIDE (portfolio-agent.js) ═══\n');

test('drawdown 9% + trending_up → DEFENSIVE (regime override, not CASH)', () => {
  const r = simulatePostureOverride({ drawdownPct: 9, winRate: 50, totalTrades: 20, regime: 'trending_up' });
  assertEqual(r.override, 'defensive', 'override');
});

test('drawdown 9% + trending_down → CASH', () => {
  const r = simulatePostureOverride({ drawdownPct: 9, winRate: 50, totalTrades: 20, regime: 'trending_down' });
  assertEqual(r.override, 'cash', 'override');
});

test('drawdown 9% + ranging → CASH', () => {
  const r = simulatePostureOverride({ drawdownPct: 9, winRate: 50, totalTrades: 20, regime: 'ranging' });
  assertEqual(r.override, 'cash', 'override');
});

test('drawdown 9% + volatile → CASH', () => {
  const r = simulatePostureOverride({ drawdownPct: 9, winRate: 50, totalTrades: 20, regime: 'volatile' });
  assertEqual(r.override, 'cash', 'override');
});

test('drawdown 9% + regime unknown → CASH', () => {
  const r = simulatePostureOverride({ drawdownPct: 9, winRate: 50, totalTrades: 20, regime: null });
  assertEqual(r.override, 'cash', 'override');
});

test('drawdown 6% → DEFENSIVE', () => {
  const r = simulatePostureOverride({ drawdownPct: 6, winRate: 50, totalTrades: 20, regime: 'ranging' });
  assertEqual(r.override, 'defensive', 'override');
});

test('winRate 30% → DEFENSIVE regardless of regime', () => {
  const r = simulatePostureOverride({ drawdownPct: 3, winRate: 30, totalTrades: 20, regime: 'trending_up' });
  assertEqual(r.override, 'defensive', 'override');
});

test('drawdown 4% + winRate 55% → no override', () => {
  const r = simulatePostureOverride({ drawdownPct: 4, winRate: 55, totalTrades: 20, regime: 'ranging' });
  assertEqual(r.override, null, 'override');
});

test('< 5 trades → no override (insufficient sample)', () => {
  const r = simulatePostureOverride({ drawdownPct: 9, winRate: 20, totalTrades: 3, regime: 'trending_up' });
  assertEqual(r.override, null, 'override');
});

// ─── RISK MANAGER PREFLIGHT SCENARIOS ─────────────────────────────────────────

console.log('\n═══ PREFLIGHT GATE (risk-manager.js) ═══\n');

const goodState = { openPositions: 0, dailyLossPct: 0, drawdownPct: 0, scramLevel: null };
const goodProposal = { symbol: 'BTC/USDT', direction: 'long', confidence: 75, position_size_suggestion_pct: 5, complexity_score: 3 };

test('CASH posture + long → rejected', () => {
  const r = simulatePreflight({ proposal: goodProposal, compassPosture: { risk_posture: 'CASH' }, state: goodState, limits: {} });
  assertEqual(r.result, 'rejected', 'result');
  assert(r.reasons.some(x => x.includes('CASH')), 'reason should mention CASH');
});

test('CASH posture + short → passed', () => {
  const r = simulatePreflight({
    proposal: { ...goodProposal, direction: 'short' },
    compassPosture: { risk_posture: 'CASH' },
    state: goodState, limits: {},
  });
  assertEqual(r.result, 'passed', 'result');
});

test('DEFENSIVE posture + long → passed with half size', () => {
  const r = simulatePreflight({ proposal: { ...goodProposal, position_size_suggestion_pct: 5 }, compassPosture: { risk_posture: 'DEFENSIVE' }, state: goodState, limits: {} });
  assertEqual(r.result, 'passed', 'result');
  assertEqual(r.proposal.position_size_suggestion_pct, 2.5, 'size should be halved to 2.5%');
});

test('DEFENSIVE posture + short → passed with full size', () => {
  const r = simulatePreflight({
    proposal: { ...goodProposal, direction: 'short', position_size_suggestion_pct: 5 },
    compassPosture: { risk_posture: 'DEFENSIVE' },
    state: goodState, limits: {},
  });
  assertEqual(r.result, 'passed', 'result');
  assertEqual(r.proposal.position_size_suggestion_pct, 5, 'short size should be untouched');
});

test('NEUTRAL posture + long → passed with full size', () => {
  const r = simulatePreflight({ proposal: goodProposal, compassPosture: { risk_posture: 'NEUTRAL' }, state: goodState, limits: {} });
  assertEqual(r.result, 'passed', 'result');
});

test('No COMPASS posture → passed (fail open)', () => {
  const r = simulatePreflight({ proposal: goodProposal, compassPosture: null, state: goodState, limits: {} });
  assertEqual(r.result, 'passed', 'result');
});

test('SCRAM crisis → all proposals rejected', () => {
  const r = simulatePreflight({ proposal: goodProposal, compassPosture: null, state: { ...goodState, scramLevel: 'crisis' }, limits: {} });
  assertEqual(r.result, 'rejected', 'result');
  assert(r.reasons.some(x => x.includes('scram')), 'reason should mention scram');
});

test('SCRAM emergency → all proposals rejected', () => {
  const r = simulatePreflight({ proposal: goodProposal, compassPosture: null, state: { ...goodState, scramLevel: 'emergency' }, limits: {} });
  assertEqual(r.result, 'rejected', 'result');
});

test('Max positions reached (8/8) → rejected', () => {
  const r = simulatePreflight({ proposal: goodProposal, compassPosture: null, state: { ...goodState, openPositions: 8 }, limits: { MAX_OPEN_POSITIONS: 8 } });
  assertEqual(r.result, 'rejected', 'result');
  assert(r.reasons.some(x => x.includes('max_positions')), 'reason should mention max_positions');
});

test('Daily loss limit breached (3.5%) → rejected', () => {
  const r = simulatePreflight({ proposal: goodProposal, compassPosture: null, state: { ...goodState, dailyLossPct: 3.5 }, limits: { MAX_DAILY_LOSS_PCT: 3 } });
  assertEqual(r.result, 'rejected', 'result');
});

test('Low confidence (55%) → rejected', () => {
  const r = simulatePreflight({ proposal: { ...goodProposal, confidence: 55 }, compassPosture: null, state: goodState, limits: { MIN_CONFIDENCE_TO_TRADE: 70 } });
  assertEqual(r.result, 'rejected', 'result');
  assert(r.reasons.some(x => x.includes('low_confidence')), 'reason should mention low_confidence');
});

test('Confidence exactly at threshold (70%) → passed', () => {
  const r = simulatePreflight({ proposal: { ...goodProposal, confidence: 70 }, compassPosture: null, state: goodState, limits: { MIN_CONFIDENCE_TO_TRADE: 70 } });
  assertEqual(r.result, 'passed', 'result');
});

test('Max drawdown exceeded (11%) → rejected before posture checks', () => {
  const r = simulatePreflight({ proposal: goodProposal, compassPosture: { risk_posture: 'NEUTRAL' }, state: { ...goodState, drawdownPct: 11 }, limits: { MAX_DRAWDOWN_PCT: 10 } });
  assertEqual(r.result, 'rejected', 'result');
  assert(r.reasons.some(x => x.includes('max_drawdown')), 'reason should mention max_drawdown');
});

test('Low complexity score (1 domain) → rejected', () => {
  const r = simulatePreflight({ proposal: { ...goodProposal, complexity_score: 1 }, compassPosture: null, state: goodState, limits: { MIN_SIGNAL_COMPLEXITY: 2 } });
  assertEqual(r.result, 'rejected', 'result');
  assert(r.reasons.some(x => x.includes('low_complexity')), 'reason should mention low_complexity');
});

test('Bootstrap infant limits (max 3 positions, now at 3) → rejected', () => {
  const r = simulatePreflight({ proposal: goodProposal, compassPosture: null, state: { ...goodState, openPositions: 3 }, limits: { MAX_OPEN_POSITIONS: 3 } });
  assertEqual(r.result, 'rejected', 'result');
});

test('All conditions good → passed with original size', () => {
  const r = simulatePreflight({ proposal: { ...goodProposal, position_size_suggestion_pct: 5 }, compassPosture: { risk_posture: 'NEUTRAL' }, state: goodState, limits: {} });
  assertEqual(r.result, 'passed', 'result');
  assertEqual(r.proposal.position_size_suggestion_pct, 5, 'size should be unchanged');
});

// ─── REGIME OVERRIDE INTEGRATION (end-to-end) ─────────────────────────────────

console.log('\n═══ REGIME OVERRIDE INTEGRATION (the bug we fixed) ═══\n');

test('[BUG REGRESSION] drawdown 9% + trending_up: posture=DEFENSIVE, long should PASS at half size', () => {
  // Step 1: portfolio-agent determines posture
  const posture = simulatePostureOverride({ drawdownPct: 9, winRate: 50, totalTrades: 20, regime: 'trending_up' });
  assertEqual(posture.override, 'defensive', 'posture override');

  // Step 2: risk-manager receives DEFENSIVE posture + long proposal
  const r = simulatePreflight({
    proposal: { ...goodProposal, position_size_suggestion_pct: 5 },
    compassPosture: { risk_posture: posture.override.toUpperCase() },
    state: goodState,
    limits: {},
  });
  assertEqual(r.result, 'passed', 'preflight result');
  assertEqual(r.proposal.position_size_suggestion_pct, 2.5, 'size should be halved');
});

test('[BUG REGRESSION] drawdown 9% + trending_down: posture=CASH, long should FAIL', () => {
  const posture = simulatePostureOverride({ drawdownPct: 9, winRate: 50, totalTrades: 20, regime: 'trending_down' });
  assertEqual(posture.override, 'cash', 'posture override');

  const r = simulatePreflight({
    proposal: goodProposal,
    compassPosture: { risk_posture: posture.override.toUpperCase() },
    state: goodState,
    limits: {},
  });
  assertEqual(r.result, 'rejected', 'preflight result');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n⚠  FAILURES DETECTED — review logic in risk-manager.js / portfolio-agent.js');
  process.exit(1);
} else {
  console.log('\n✓  All scenarios passed');
}
