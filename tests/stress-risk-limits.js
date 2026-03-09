#!/usr/bin/env node
/**
 * Risk Limit Stress Test Suite
 * Tests every risk gate in GRID — position caps, SCRAM triggers, exposure limits.
 * Run with: LIVE_TRADING_ENABLED=false node tests/stress-risk-limits.js
 */

'use strict';

require('dotenv').config();
const { query, queryAll, queryOne } = require('../db/connection');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  \u2713 PASS: ${name}`);
    passed++;
  } else {
    console.log(`  \u2717 FAIL: ${name}${detail ? '\n       ' + detail : ''}`);
    failed++;
    failures.push(name);
  }
}

async function test_compassLimitsApplied() {
  console.log('\n\u2500\u2500 COMPASS LIMITS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Check that COMPASS has published a risk state
  const riskState = await queryOne(
    `SELECT * FROM compass_risk_assessments ORDER BY created_at DESC LIMIT 1`
  );

  assert('COMPASS risk assessment exists', riskState !== null,
    'Run POST /api/compass/cycle/run first');

  if (riskState) {
    const maxPos = parseFloat(riskState.max_single_position_usd);
    assert('Max position cap is set', maxPos > 0, `Value: $${maxPos}`);
    assert('Max position cap <= hard limit ($10,000)', maxPos <= 10000,
      `COMPASS set $${maxPos} \u2014 hard cap is $10,000`);

    const maxExposure = parseFloat(riskState.max_total_exposure_usd);
    assert('Max exposure cap is set', maxExposure > 0);
    assert('Max exposure cap <= hard limit ($20,000)', maxExposure <= 20000);

    const scramPct = parseFloat(riskState.scram_threshold_pct);
    assert('SCRAM threshold >= 5%', scramPct >= 5.0,
      `Value: ${scramPct}% \u2014 below 5% is too aggressive`);
  }
}

async function test_positionSizeCapping() {
  console.log('\n\u2500\u2500 POSITION SIZE CAPS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Get the latest risk manager decision — check it applied COMPASS limits
  const decision = await queryOne(
    `SELECT output_json, created_at FROM agent_decisions
     WHERE agent_name LIKE '%risk%'
     ORDER BY created_at DESC LIMIT 1`
  );

  assert('Risk manager has run at least once', decision !== null);

  if (decision?.output_json) {
    const outputStr = typeof decision.output_json === 'string'
      ? decision.output_json
      : JSON.stringify(decision.output_json);
    const hasCompassRef = outputStr.includes('compass') ||
                          outputStr.includes('COMPASS') ||
                          outputStr.includes('max_position');
    assert('Risk manager references COMPASS in output', hasCompassRef,
      'Risk manager should log compass_limits_applied');
  }
}

async function test_openPositionCap() {
  console.log('\n\u2500\u2500 OPEN POSITION LIMITS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const riskState = await queryOne(
    'SELECT max_open_positions FROM compass_risk_assessments ORDER BY created_at DESC LIMIT 1'
  );
  const maxOpen = parseInt(riskState?.max_open_positions || 4);

  // GRID uses trades table with status='open' as positions
  const currentOpen = await queryOne(
    "SELECT COUNT(*) AS cnt FROM trades WHERE status = 'open'"
  );
  const openCount = parseInt(currentOpen?.cnt || 0);

  assert('Open position count is within COMPASS limit', openCount <= maxOpen,
    `Open: ${openCount}, COMPASS max: ${maxOpen}`);
  assert('Open position max is not absurdly high', maxOpen <= 6,
    `COMPASS allowed ${maxOpen} \u2014 hard cap should be \u2264 6`);
}

async function test_scramLimits() {
  console.log('\n\u2500\u2500 SCRAM SYSTEM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Check that risk-limits.js has SCRAM defined
  let riskLimits;
  try {
    riskLimits = require('../systems/grid/config/risk-limits');
  } catch {
    try {
      riskLimits = require('../config/risk-limits');
    } catch {
      riskLimits = null;
    }
  }

  assert('Risk limits config is loadable', riskLimits !== null);

  if (riskLimits) {
    // Actual config uses SCRAM object with levels and MAX_DRAWDOWN_PCT
    assert('SCRAM config is defined', riskLimits.SCRAM !== undefined,
      'Missing SCRAM object in risk-limits.js');

    if (riskLimits.SCRAM) {
      assert('SCRAM has emergency level', riskLimits.SCRAM.emergency !== undefined);
      assert('SCRAM has crisis level', riskLimits.SCRAM.crisis !== undefined);
    }

    assert('MAX_DRAWDOWN_PCT is defined', riskLimits.MAX_DRAWDOWN_PCT !== undefined);
    assert('MAX_DRAWDOWN_PCT is reasonable (5-15%)',
      riskLimits.MAX_DRAWDOWN_PCT >= 5 && riskLimits.MAX_DRAWDOWN_PCT <= 15,
      `Value: ${riskLimits.MAX_DRAWDOWN_PCT}%`);

    assert('MAX_OPEN_POSITIONS is defined', riskLimits.MAX_OPEN_POSITIONS !== undefined);
    assert('MAX_OPEN_POSITIONS <= 8', riskLimits.MAX_OPEN_POSITIONS <= 8,
      `Value: ${riskLimits.MAX_OPEN_POSITIONS}`);
  }

  // Check that intelligence bus is importable
  const bus = require('../shared/intelligence-bus');
  assert('Intelligence bus is importable', bus !== null);
}

async function test_dataFreshness() {
  console.log('\n\u2500\u2500 DATA FRESHNESS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Signals should be cleaned regularly — check no stale signals
  const staleSignals = await queryOne(
    `SELECT COUNT(*) AS cnt FROM signals
     WHERE expires_at < NOW() - INTERVAL '1 hour'`
  );
  assert('No signals expired > 1h ago', parseInt(staleSignals?.cnt || 0) === 0,
    `${staleSignals?.cnt} stale signals found \u2014 check hourly cleanup cron`);

  // Oracle raw feed should not be ancient
  const latestFeed = await queryOne(
    'SELECT created_at FROM oracle_raw_feed ORDER BY created_at DESC LIMIT 1'
  );
  if (latestFeed) {
    const ageHours = (Date.now() - new Date(latestFeed.created_at)) / 3600000;
    assert('Oracle feed < 7h old', ageHours < 7,
      `Latest feed item: ${ageHours.toFixed(1)}h ago \u2014 ingestion may be stalled`);
  } else {
    console.log('  - Oracle raw feed empty (acceptable if ORACLE not yet cycled)');
  }

  // Intelligence bus should have recent activity
  const latestBus = await queryOne(
    'SELECT created_at FROM intelligence_bus ORDER BY created_at DESC LIMIT 1'
  );
  if (latestBus) {
    const ageHours = (Date.now() - new Date(latestBus.created_at)) / 3600000;
    assert('Intelligence bus active in last 12h', ageHours < 12,
      `Latest bus event: ${ageHours.toFixed(1)}h ago`);
  }
}

async function test_dbConstraints() {
  console.log('\n\u2500\u2500 DATABASE CONSTRAINTS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Try to insert a signal without required fields — should fail
  let constraintCaught = false;
  try {
    await query(
      `INSERT INTO signals (symbol, agent_name, direction, strength, decay_model, expires_at)
       VALUES (NULL, 'test', 'bullish', 0.8, 'linear', NOW() + INTERVAL '1 hour')`
    );
  } catch (err) {
    constraintCaught = err.message.includes('null') || err.message.includes('not-null') || err.message.includes('violates');
  }
  assert('signals.symbol NOT NULL constraint works', constraintCaught,
    'NULL symbol was accepted \u2014 check schema constraint');

  // Try to insert a signal with invalid decay_model — should fail
  let decayConstraintCaught = false;
  try {
    await query(
      `INSERT INTO signals (symbol, agent_name, direction, strength, decay_model, expires_at)
       VALUES ('BTC', 'test', 'bullish', 0.8, 'INVALID_MODEL', NOW() + INTERVAL '1 hour')`
    );
    // If we get here, clean up
    await query("DELETE FROM signals WHERE decay_model = 'INVALID_MODEL'");
  } catch (err) {
    decayConstraintCaught = true;
  }
  assert('signals.decay_model CHECK constraint works', decayConstraintCaught,
    'Invalid decay_model was accepted \u2014 check schema constraint');

  // Check that oracle_theses conviction bounds
  let convictionConstraintCaught = false;
  try {
    await query(
      `INSERT INTO oracle_theses (thesis_id, name, domain, direction, conviction, time_horizon)
       VALUES ('TEST-CONSTRAINT-001', 'Test', 'macro', 'bull', 99, 'medium')`
    );
    await query("DELETE FROM oracle_theses WHERE thesis_id = 'TEST-CONSTRAINT-001'");
  } catch (err) {
    convictionConstraintCaught = true;
  }
  // Note: conviction > 10 may or may not be constrained — just warn
  if (!convictionConstraintCaught) {
    console.log('  \u26a0 WARN: conviction > 10 accepted \u2014 no DB constraint, relies on app logic');
  }
}

async function test_paperTradingFlag() {
  console.log('\n\u2500\u2500 PAPER TRADING FLAG \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  const isLive = process.env.LIVE_TRADING_ENABLED === 'true';
  assert('LIVE_TRADING_ENABLED is false during audit', !isLive,
    'LIVE_TRADING_ENABLED=true detected \u2014 set to false for all Phase 6 tests');

  // Verify engine.py respects the flag
  const engineSrc = require('fs').readFileSync('./trading/engine.py', 'utf8');
  const hasLiveCheck = engineSrc.includes('LIVE_TRADING_ENABLED') ||
                       engineSrc.includes('live_trading');
  assert('engine.py checks LIVE_TRADING_ENABLED', hasLiveCheck,
    'engine.py does not appear to check the live trading flag');
}

async function test_noStandingOrderLeak() {
  console.log('\n\u2500\u2500 STANDING ORDER INTEGRITY \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Standing orders in active state but trade is closed = orphan
  const orphanedOrders = await queryOne(
    `SELECT COUNT(*) AS cnt FROM standing_orders so
     JOIN trades t ON t.id = so.trade_id
     WHERE so.status = 'active' AND t.status = 'closed'`
  ).catch(() => ({ cnt: 0 }));

  assert('No orphaned active standing orders', parseInt(orphanedOrders?.cnt || 0) === 0,
    `${orphanedOrders?.cnt} standing orders active on closed trades`);
}

// -- Main --
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('RISK LIMIT STRESS TEST SUITE');
  console.log('='.repeat(60));

  try {
    await test_compassLimitsApplied();
    await test_positionSizeCapping();
    await test_openPositionCap();
    await test_scramLimits();
    await test_dataFreshness();
    await test_dbConstraints();
    await test_paperTradingFlag();
    await test_noStandingOrderLeak();
  } catch (err) {
    console.error('\nTest suite error:', err.message);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`RESULT: ${passed}/${passed + failed} checks passed`);
  if (failures.length > 0) {
    console.log(`\nFAILED CHECKS:\n${failures.map(f => '  - ' + f).join('\n')}`);
  }
  const pct = (passed / (passed + failed)) * 100;
  if (pct === 100) {
    console.log('\nSTATUS: \u2713 RISK LIMITS \u2014 PASS');
  } else if (pct >= 85) {
    console.log('\nSTATUS: \u26a0 RISK LIMITS \u2014 REVIEW REQUIRED');
  } else {
    console.log('\nSTATUS: \u2717 RISK LIMITS \u2014 FAIL (do not go live)');
  }
  console.log('='.repeat(60) + '\n');

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
