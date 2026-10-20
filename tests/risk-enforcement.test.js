'use strict';

/**
 * Unit tests for the code-enforced risk gate. No DB, no network, no Anthropic.
 * Run:  node --test tests/risk-enforcement.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Live limits are the reference ruleset (paper mode loosens some of them on purpose)
process.env.LIVE_TRADING_ENABLED = 'true';

const riskLimits = require('../systems/grid/config/risk-limits');
const {
  enforceHardLimits, mergeRiskDecisions, computeEffectiveLimits, mergeStrictest,
  normalizeDirection, findBlackoutEvent,
} = require('../systems/grid/agents/risk-enforcement');
const {
  computeResolution, applySizeMultiplier, resolveProposal, toBullBear,
} = require('../shared/conflict-resolver');

const NOW = new Date('2026-10-20T12:00:00Z');

function effective(state = {}) {
  return computeEffectiveLimits(
    { bootstrapPhase: 'graduated', scramLevel: null, ...state },
    { base: riskLimits.getRiskLimits(), bootstrap: riskLimits.BOOTSTRAP, scram: riskLimits.SCRAM }
  );
}

function longProposal(over = {}) {
  return {
    symbol: 'BTC/USDT', direction: 'long', confidence: 80, complexity_score: 3,
    entry_price: 100, sl_price: 96, tp_price: 112, approved_size_pct: 3, asset_class: 'crypto',
    ...over,
  };
}

function baseState(over = {}) {
  return {
    equity: 10000, openPositions: 0, openTrades: [], dailyLossPct: 0, scramLevel: null,
    correlations: {}, upcomingEvents: [], now: NOW, ...over,
  };
}

const run = (p, s = baseState(), l = effective(), o = { mode: 'live' }) => enforceHardLimits(p, s, l, o);

// ---------------------------------------------------------------------------
// enforceHardLimits
// ---------------------------------------------------------------------------

test('valid long passes and returns the trusted, normalised proposal', () => {
  const r = run(longProposal());
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.equal(r.proposal.direction, 'long');
  assert.equal(r.proposal.mode, 'live');
  assert.equal(r.proposal.approved_size_pct, 3);
  assert.equal(r.proposal.sl_price, 96);
});

test('missing stop-loss is rejected (null / undefined / NaN / 0)', () => {
  for (const sl of [null, undefined, NaN, 0, 'abc', Infinity]) {
    const r = run(longProposal({ sl_price: sl }));
    assert.equal(r.ok, false, `sl=${String(sl)} must be rejected`);
    assert.match(r.reasons.join(';'), /missing_stop_loss/);
  }
});

test('stop on the wrong side of entry is rejected for both directions', () => {
  const longWrong = run(longProposal({ sl_price: 104 }));            // stop ABOVE a long entry
  assert.equal(longWrong.ok, false);
  assert.match(longWrong.reasons.join(';'), /stop_wrong_side/);

  const shortWrong = run(longProposal({ direction: 'short', sl_price: 96, tp_price: 90 })); // stop BELOW a short entry
  assert.equal(shortWrong.ok, false);
  assert.match(shortWrong.reasons.join(';'), /stop_wrong_side/);

  const shortOk = run(longProposal({ direction: 'short', sl_price: 104, tp_price: 88 }));
  assert.equal(shortOk.ok, true, shortOk.reasons.join('; '));
});

test('take-profit on the wrong side is rejected (no Math.abs laundering)', () => {
  const r = run(longProposal({ tp_price: 90 }));   // long with target BELOW entry: abs() would call this a 10-point reward
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(';'), /target_wrong_side/);
});

test('fee-adjusted R:R below the minimum is rejected', () => {
  const r = run(longProposal({ tp_price: 103 }));  // reward 3 - 0.2 fee vs risk 4
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(';'), /low_risk_reward/);
});

test('NaN / non-finite / non-numeric confidence is rejected', () => {
  for (const confidence of [NaN, undefined, null, 'high', Infinity, -5, 140]) {
    const r = run(longProposal({ confidence }));
    assert.equal(r.ok, false, `confidence=${String(confidence)} must be rejected`);
    assert.match(r.reasons.join(';'), /invalid_confidence/);
  }
  // numeric strings are accepted as numbers
  assert.equal(run(longProposal({ confidence: '82' })).ok, true);
});

test('low confidence is rejected; exploration gets the lower threshold only from the TRUSTED flag', () => {
  assert.equal(run(longProposal({ confidence: 55 })).ok, false);
  assert.equal(run(longProposal({ confidence: 55, exploration: true })).ok, true);
  assert.equal(run(longProposal({ confidence: 55, exploration: 'true' })).ok, false); // truthy string is not `true`
});

test('size is clamped to MAX_SINGLE_POSITION_PCT AFTER a conflict-resolver boost', () => {
  const limits = effective();
  const cap = limits.MAX_SINGLE_POSITION_PCT;                    // 5 live
  const boosted = applySizeMultiplier(4.8, 1.3, cap);            // naive 6.24
  assert.ok(boosted <= cap, `resolver boost ${boosted} must not exceed cap ${cap}`);

  // even if some other layer hands in an oversize value, the final gate clamps it
  const r = run(longProposal({ approved_size_pct: 6.24 }), baseState(), limits);
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.ok(r.proposal.approved_size_pct <= cap);
  assert.ok(r.adjustments.some(a => /clamped/.test(a)));
});

test('infant bootstrap caps at 2% even when SCRAM elevated would allow 3%', () => {
  const limits = effective({ bootstrapPhase: 'infant', scramLevel: 'elevated' });
  const r = run(longProposal({ approved_size_pct: 5 }), baseState({ scramLevel: 'elevated' }), limits, { mode: 'paper' });
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.equal(r.proposal.approved_size_pct, 2);
});

test('MAX_SINGLE_TRADE_LOSS_PCT scales size down by stop distance', () => {
  // 50% stop: size * 50% must stay <= 2% of equity => size <= 4%
  const r = run(longProposal({ entry_price: 100, sl_price: 50, tp_price: 300, approved_size_pct: 5 }));
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.ok(r.proposal.approved_size_pct <= 4 + 1e-9, `got ${r.proposal.approved_size_pct}`);
  assert.ok(r.proposal.risk_pct_of_equity <= 2 + 1e-9);
});

test('MAX_ASSET_CLASS_EXPOSURE_PCT limits size to remaining headroom, rejects when none', () => {
  const heavy = (pct) => [{ symbol: 'ETH/USDT', side: 'buy', asset_class: 'crypto', entry_price: 100, quantity: pct }]; // notional pct*100 = pct% of 10k
  const clamped = run(longProposal({ approved_size_pct: 5 }), baseState({ openTrades: heavy(38) }));
  assert.equal(clamped.ok, true, clamped.reasons.join('; '));
  assert.equal(clamped.proposal.approved_size_pct, 2, 'only 2% headroom left under the 40% class cap');

  const tight = run(longProposal({ approved_size_pct: 5 }), baseState({ openTrades: heavy(39.5) }));
  assert.equal(tight.ok, false, 'headroom 0.5% < MIN_POSITION_PCT should reject');
  assert.match(tight.reasons.join(';'), /below_min_position/);

  const full = run(longProposal(), baseState({ openTrades: heavy(41) }));
  assert.equal(full.ok, false);

  const roomy = run(longProposal({ approved_size_pct: 3 }), baseState({ openTrades: heavy(30) }));
  assert.equal(roomy.ok, true, roomy.reasons.join('; '));
});

test('MIN_POSITION_PCT raises tiny sizes up to the minimum when the ceilings allow', () => {
  const r = run(longProposal({ approved_size_pct: 0.2 }));
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.equal(r.proposal.approved_size_pct, effective().MIN_POSITION_PCT);
});

test('COMPASS cap is a hard ceiling', () => {
  const r = run(longProposal({ approved_size_pct: 4 }), baseState(), effective(), { mode: 'live', compassMaxPct: 2 });
  assert.equal(r.ok, true, r.reasons.join('; '));
  assert.equal(r.proposal.approved_size_pct, 2);
});

test('EVENT_BLACKOUT_HOURS blocks entries before a high-impact event', () => {
  const ev = { event_name: 'FOMC', event_type: 'macro', impact_estimate: 'high', affected_assets: null,
    event_date: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString() };
  const blocked = run(longProposal(), baseState({ upcomingEvents: [ev] }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.reasons.join(';'), /event_blackout/);

  const far = { ...ev, event_date: new Date(NOW.getTime() + 5 * 3600 * 1000).toISOString() };
  assert.equal(run(longProposal(), baseState({ upcomingEvents: [far] })).ok, true);

  const lowImpact = { ...ev, impact_estimate: 'low' };
  assert.equal(run(longProposal(), baseState({ upcomingEvents: [lowImpact] })).ok, true);

  const otherAsset = { ...ev, affected_assets: ['SOL'] };
  assert.equal(findBlackoutEvent([otherAsset], 'BTC/USDT', NOW, 2), null);
});

test('events_calendar unreadable fails closed in live mode only', () => {
  assert.equal(run(longProposal(), baseState({ eventsError: true })).ok, false);
  assert.equal(run(longProposal(), baseState({ eventsError: true }), effective(), { mode: 'paper' }).ok, true);
});

test('state gates: SCRAM, max positions, daily loss, unavailable equity', () => {
  assert.equal(run(longProposal(), baseState({ scramLevel: 'crisis' }), effective({ scramLevel: 'crisis' })).ok, false);
  assert.equal(run(longProposal(), baseState({ openPositions: 99 })).ok, false);
  assert.equal(run(longProposal(), baseState({ dailyLossPct: 3.5 })).ok, false);
  const noEquity = run(longProposal(), baseState({ equity: undefined }));
  assert.equal(noEquity.ok, false);
  assert.match(noEquity.reasons.join(';'), /risk_check_unavailable/);
});

test('bootstrap PAPER_ONLY blocks real live execution', () => {
  const limits = effective({ bootstrapPhase: 'infant' });
  assert.equal(limits.PAPER_ONLY, true);
  const r = run(longProposal({ approved_size_pct: 2 }), baseState(), limits, { mode: 'live' });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(';'), /bootstrap_paper_only/);
});

test('proposal-supplied mode / exploration cannot loosen anything', () => {
  const r = run(longProposal({ mode: 'paper', confidence: 55, exploration: undefined }), baseState(), effective(), { mode: 'live' });
  assert.equal(r.ok, false);               // 55 < 70 and not a trusted exploration
  const ok = run(longProposal({ mode: 'paper' }));
  assert.equal(ok.proposal.mode, 'live');  // execution mode wins over the proposal's claim
});

// ---------------------------------------------------------------------------
// mergeRiskDecisions — the LLM only decides among preflight-passed proposals
// ---------------------------------------------------------------------------

test('invented symbols are dropped and never approved', () => {
  const passed = [longProposal({ symbol: 'BTC/USDT' })];
  const out = mergeRiskDecisions({
    decisions: [{ symbol: 'DOGE/USDT', action: 'approve', position_size_pct: 5 }],
  }, passed);
  assert.equal(out.approved.length, 0);
  assert.equal(out.dropped.length, 1);
});

test('no `|| passed[0]` fallback: an unknown symbol does not inherit another proposal', () => {
  const passed = [longProposal({ symbol: 'BTC/USDT' }), longProposal({ symbol: 'ETH/USDT' })];
  const out = mergeRiskDecisions({ decisions: [{ symbol: 'XRP/USDT', action: 'approve' }] }, passed);
  assert.deepEqual(out.approved, []);
});

test('direction mismatch on the decision is dropped', () => {
  const passed = [longProposal()];
  const out = mergeRiskDecisions({ decisions: [{ symbol: 'BTC/USDT', direction: 'short', action: 'approve' }] }, passed);
  assert.equal(out.approved.length, 0);
});

test('LLM modifications cannot override sl/tp/entry/mode/exploration', () => {
  const passed = [longProposal()];
  const out = mergeRiskDecisions({
    decisions: [{
      symbol: 'BTC/USDT', action: 'modify', position_size_pct: 2,
      modifications: { sl_price: 1, tp_price: 9999, entry_price: 5, mode: 'paper', exploration: true, position_size_pct: 2 },
    }],
  }, passed);
  assert.equal(out.approved.length, 1);
  const a = out.approved[0];
  assert.equal(a.sl_price, 96);
  assert.equal(a.tp_price, 112);
  assert.equal(a.entry_price, 100);
  assert.notEqual(a.exploration, true);
  assert.equal(a.mode, undefined);
  assert.equal(a.approved_size_pct, 2);
});

test('direct approved/rejected arrays from the model are NOT trusted', () => {
  const passed = [longProposal()];
  const out = mergeRiskDecisions({ approved: [{ symbol: 'BTC/USDT', sl_price: 1 }], rejected: [] }, passed);
  assert.equal(out.approved.length, 0);
  assert.equal(out.rejected[0].reason, 'risk_manager_no_valid_decision');
});

test('duplicate decisions for the same proposal approve it once', () => {
  const passed = [longProposal()];
  const out = mergeRiskDecisions({ decisions: [
    { symbol: 'BTC/USDT', action: 'approve' }, { symbol: 'BTC/USDT', action: 'approve' },
  ] }, passed);
  assert.equal(out.approved.length, 1);
});

// ---------------------------------------------------------------------------
// getEffectiveLimits / strictest wins
// ---------------------------------------------------------------------------

test('strictest wins: SCRAM elevated / later phases can never loosen the infant 2% cap', () => {
  const infantElevated = effective({ bootstrapPhase: 'infant', scramLevel: 'elevated' });
  assert.equal(infantElevated.MAX_SINGLE_POSITION_PCT, 2);   // elevated says 3, infant says 2
  assert.equal(infantElevated.MAX_OPEN_POSITIONS, 3);        // elevated says 5, infant says 3
  assert.equal(infantElevated.NO_NEW_POSITIONS, false);

  const learningElevated = effective({ bootstrapPhase: 'learning', scramLevel: 'elevated' });
  assert.equal(learningElevated.MAX_SINGLE_POSITION_PCT, 3);
  assert.equal(learningElevated.MAX_DAILY_LOSS_PCT, 2);

  const crisis = effective({ bootstrapPhase: 'graduated', scramLevel: 'crisis' });
  assert.equal(crisis.MAX_SINGLE_POSITION_PCT, 0);
  assert.equal(crisis.NO_NEW_POSITIONS, true);
  assert.equal(crisis.CLOSE_LOSING_POSITIONS, true);
});

test('mergeStrictest: max-type uses min, min-type uses max, booleans OR', () => {
  const m = mergeStrictest(
    { MAX_X: 5, MIN_Y: 1, EVENT_BLACKOUT_HOURS: 2, PAPER_ONLY: false },
    { MAX_X: 8, MIN_Y: 0.5, EVENT_BLACKOUT_HOURS: 1, PAPER_ONLY: true },
    { MAX_X: 3, MIN_Y: 4, PAPER_ONLY: false }
  );
  assert.deepEqual(m, { MAX_X: 3, MIN_Y: 4, EVENT_BLACKOUT_HOURS: 2, PAPER_ONLY: true });
});

// ---------------------------------------------------------------------------
// conflict resolver
// ---------------------------------------------------------------------------

const bullThesis = (conviction = 8.5, extra = {}) => ({ direction: 'bull', conviction, time_horizon: 'strategic', payload: { name: 't' }, ...extra });

test('direction mapping: bullish/long/buy => bull, bearish/short/sell => bear', () => {
  for (const d of ['bullish', 'long', 'buy', 'BULL', ' Long ']) assert.equal(toBullBear(d), 'bull', d);
  for (const d of ['bearish', 'short', 'sell', 'bear']) assert.equal(toBullBear(d), 'bear', d);
  assert.equal(toBullBear('neutral'), null);
  assert.equal(normalizeDirection('bullish'), 'long');
});

test('a "bullish" proposal is treated as bull (boosted by bull confluence, not mapped to bear)', () => {
  const theses = [bullThesis(8.5), bullThesis(7.5)];
  const bullish = computeResolution(theses, { direction: 'bullish' });
  assert.equal(bullish.multiplier, 1.3);
  assert.ok(bullish.confluenceFlag);

  const bearish = computeResolution(theses, { direction: 'bearish', time_horizon: 'strategic' });
  assert.ok(bearish.multiplier <= 1, 'bear proposal must not be boosted by bull theses');
});

test('opposing strategic thesis reduces; unknown direction is not adjusted', () => {
  const r = computeResolution([bullThesis(8)], { direction: 'short', time_horizon: 'strategic' });
  assert.equal(r.multiplier, 0.6);
  assert.equal(computeResolution([bullThesis(8)], { direction: 'sideways' }), null);
});

test('boost can never exceed the limit, reductions still apply in full', () => {
  assert.equal(applySizeMultiplier(4.5, 1.3, 5), 5);
  assert.equal(applySizeMultiplier(2, 1.3, 5), 2.6);
  assert.equal(applySizeMultiplier(4, 0.6, 5), 2.4);
  assert.equal(applySizeMultiplier(6, 1.3, 5), 6, 'cap never cuts an input already above it (final gate clamps)');
  assert.equal(applySizeMultiplier(3, 99, 100), 3.9, 'multiplier itself is clamped to 1.3');
});

test('resolveProposal uses injected theses (no DB) and sets a bounded multiplier', async () => {
  const p = { symbol: 'BTC/USDT', direction: 'bullish' };
  await resolveProposal(p, { getTheses: async () => [bullThesis(9), bullThesis(8)] });
  assert.equal(p.size_multiplier, 1.3);
  assert.ok(p.size_multiplier >= 0.5 && p.size_multiplier <= 1.3);
});
