'use strict';

/**
 * GRID Behavioral Audit — checks WHAT the system would do, not just if the code runs.
 *
 * Unlike a code audit, this connects to the real DB and validates:
 *  - Is the system actually in position to trade?
 *  - Are the risk gates calibrated correctly for current conditions?
 *  - Are there logic conflicts between COMPASS, ORACLE, and GRID?
 *  - What would prevent a trade RIGHT NOW and is that correct?
 *
 * Run against local DB:      node scripts/behavioral-audit.js
 * Run against production DB: node scripts/behavioral-audit.js --db "postgresql://..."
 * Safe to run anytime — read-only, no writes.
 */

// Allow --db "postgresql://..." CLI override before loading dotenv/connection
const dbArg = process.argv.findIndex(a => a === '--db');
if (dbArg !== -1 && process.argv[dbArg + 1]) {
  process.env.DATABASE_URL = process.argv[dbArg + 1];
}

require('dotenv').config();
const { queryOne, queryAll } = require('../db/connection');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PASS    = '✓';
const WARN    = '⚠';
const FAIL    = '✗';
const INFO    = '·';

let warnings = 0;
let failures = 0;

function log(icon, label, detail = '') {
  const line = detail ? `  ${icon} ${label}: ${detail}` : `  ${icon} ${label}`;
  console.log(line);
  if (icon === WARN) warnings++;
  if (icon === FAIL) failures++;
}

function section(title) {
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(55));
}

// ─── Audit checks ─────────────────────────────────────────────────────────────

async function auditTradingActivity() {
  section('1. TRADING ACTIVITY');

  const lastTrade = await queryOne(
    `SELECT opened_at, symbol, side, status FROM trades ORDER BY opened_at DESC LIMIT 1`
  );

  if (!lastTrade) {
    log(WARN, 'No trades ever recorded', 'system may not have traded yet');
    return;
  }

  const hoursAgo = (Date.now() - new Date(lastTrade.opened_at).getTime()) / (1000 * 60 * 60);
  const label = `${lastTrade.symbol} ${lastTrade.side} (${Math.round(hoursAgo)}h ago)`;

  if (hoursAgo > 48) {
    log(FAIL, 'Last trade > 48h ago', label);
  } else if (hoursAgo > 24) {
    log(WARN, 'Last trade > 24h ago', label);
  } else {
    log(PASS, 'Recent trade activity', label);
  }

  const openCount = await queryOne(`SELECT COUNT(*) as count FROM trades WHERE status = 'open'`);
  log(INFO, 'Open positions', openCount?.count || 0);

  const last24h = await queryOne(`
    SELECT COUNT(*) as count FROM trades WHERE opened_at > NOW() - INTERVAL '24 hours'
  `);
  log(INFO, 'Trades opened last 24h', last24h?.count || 0);
}

async function auditMarketRegime() {
  section('2. MARKET REGIME');

  const regime = await queryOne(
    `SELECT regime, confidence, created_at FROM market_regime ORDER BY created_at DESC LIMIT 1`
  );

  if (!regime) {
    log(WARN, 'No regime classification found', 'regime classifier may not have run');
    return;
  }

  const ageHours = (Date.now() - new Date(regime.created_at).getTime()) / (1000 * 60 * 60);

  if (ageHours > 12) {
    log(WARN, 'Regime classification is stale', `${Math.round(ageHours)}h old — expected < 4h`);
  } else {
    log(PASS, 'Regime is fresh', `${Math.round(ageHours)}h old`);
  }

  log(INFO, 'Current regime', `${regime.regime} (confidence: ${regime.confidence})`);

  if (regime.regime === 'trending_up') {
    log(INFO, 'Market is BULLISH', 'system should be generating long proposals');
  } else if (regime.regime === 'trending_down') {
    log(INFO, 'Market is BEARISH', 'short proposals expected');
  }
}

async function auditCompassPosture() {
  section('3. COMPASS POSTURE');

  const latest = await queryOne(`
    SELECT payload, created_at FROM intelligence_bus
    WHERE source_system = 'compass'
      AND event_type = 'allocation_guidance'
      AND (expires_at IS NULL OR expires_at > NOW())
      AND superseded_by IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `);

  if (!latest) {
    log(WARN, 'No COMPASS allocation guidance on bus', 'COMPASS may not have run');
    return;
  }

  const ageHours = (Date.now() - new Date(latest.created_at).getTime()) / (1000 * 60 * 60);
  const p = typeof latest.payload === 'string' ? JSON.parse(latest.payload) : latest.payload;
  const posture = p?.risk_posture || 'unknown';

  if (ageHours > 8) {
    log(WARN, 'COMPASS guidance is stale', `${Math.round(ageHours)}h old — expected < 6h`);
  } else {
    log(PASS, 'COMPASS guidance is fresh', `${Math.round(ageHours)}h old`);
  }

  if (posture === 'cash') {
    log(FAIL, 'COMPASS posture is CASH', 'ALL long trades are blocked');
  } else if (posture === 'defensive') {
    log(WARN, 'COMPASS posture is DEFENSIVE', 'long trades allowed at 50% size');
  } else if (posture === 'neutral' || posture === 'aggressive') {
    log(PASS, 'COMPASS posture allows trading', posture);
  } else {
    log(WARN, 'Unknown COMPASS posture', posture);
  }

  if (p?.posture_reasoning) {
    log(INFO, 'Posture reasoning', p.posture_reasoning.slice(0, 150));
  }

  // Cross-check: CASH posture in a bullish market is a logic conflict
  const regime = await queryOne(
    `SELECT regime FROM market_regime ORDER BY created_at DESC LIMIT 1`
  );
  if (posture === 'cash' && regime?.regime === 'trending_up') {
    log(FAIL, 'LOGIC CONFLICT: CASH posture + BULLISH regime', 'system locked out of recovery — check portfolio-agent.js regime override');
  } else if (posture === 'cash' && regime?.regime) {
    log(PASS, 'CASH posture aligned with regime', `regime=${regime.regime}`);
  }
}

async function auditRiskGates() {
  section('4. RISK GATES');

  // Drawdown
  const hwm = await queryOne(`SELECT MAX(total_value) as hwm FROM equity_snapshots`);
  const highWaterMark = parseFloat(hwm?.hwm || 0);

  if (highWaterMark > 0) {
    const startingCapital = parseFloat(process.env.STARTING_CAPITAL || '10000');
    const realised = await queryOne(`SELECT COALESCE(SUM(pnl_realised),0) as total FROM trades WHERE status='closed'`);
    const unrealised = await queryOne(`SELECT COALESCE(SUM(unrealised_pnl),0) as total FROM portfolio_state`);
    const currentEquity = startingCapital + parseFloat(realised?.total || 0) + parseFloat(unrealised?.total || 0);
    const drawdownPct = currentEquity < highWaterMark
      ? ((highWaterMark - currentEquity) / highWaterMark) * 100
      : 0;

    if (drawdownPct >= 10) {
      log(FAIL, 'MAX DRAWDOWN exceeded', `${drawdownPct.toFixed(1)}% >= 10% — SCRAM should be active`);
    } else if (drawdownPct >= 8) {
      log(WARN, 'Drawdown in COMPASS CASH zone', `${drawdownPct.toFixed(1)}% — check regime override is working`);
    } else if (drawdownPct >= 5) {
      log(WARN, 'Drawdown in DEFENSIVE zone', `${drawdownPct.toFixed(1)}%`);
    } else {
      log(PASS, 'Drawdown within normal range', `${drawdownPct.toFixed(1)}%`);
    }
  } else {
    log(INFO, 'No equity snapshots yet', 'drawdown check skipped');
  }

  // SCRAM
  const scram = await queryOne(
    `SELECT level, trigger_name, activated_at FROM scram_events WHERE cleared_at IS NULL LIMIT 1`
  );
  if (scram) {
    log(FAIL, `SCRAM ACTIVE: ${scram.level}`, `trigger=${scram.trigger_name}, since=${new Date(scram.activated_at).toISOString()}`);
  } else {
    log(PASS, 'No active SCRAM');
  }

  // Daily loss
  const dailyPnl = await queryOne(`
    SELECT COALESCE(SUM(pnl_realised),0) as pnl
    FROM trades WHERE status='closed' AND closed_at > NOW() - INTERVAL '24 hours'
  `);
  const dailyLoss = Math.abs(Math.min(0, parseFloat(dailyPnl?.pnl || 0)));
  const startCap = parseFloat(process.env.STARTING_CAPITAL || '10000');
  const dailyLossPct = (dailyLoss / startCap) * 100;
  if (dailyLossPct >= 3) {
    log(FAIL, 'Daily loss limit breached', `${dailyLossPct.toFixed(1)}% >= 3%`);
  } else {
    log(PASS, 'Daily loss within limit', `${dailyLossPct.toFixed(1)}%`);
  }
}

async function auditSignalHealth() {
  section('5. SIGNAL HEALTH');

  const activeSignals = await queryOne(
    `SELECT COUNT(*) as count FROM signals WHERE expires_at > NOW()`
  );
  const count = parseInt(activeSignals?.count || 0);

  if (count === 0) {
    log(FAIL, 'No active signals', 'knowledge agents may not be running or signals expired');
  } else if (count < 5) {
    log(WARN, 'Very few active signals', `${count} — expected 10+`);
  } else {
    log(PASS, 'Active signals present', count);
  }

  // Signal breakdown by domain
  const byAgent = await queryAll(`
    SELECT agent_name, COUNT(*) as count
    FROM signals WHERE expires_at > NOW()
    GROUP BY agent_name ORDER BY count DESC
  `);
  for (const row of byAgent) {
    log(INFO, `  ${row.agent_name}`, `${row.count} signals`);
  }

  // Signals without symbol (base-agent skips these)
  const noSymbol = await queryOne(
    `SELECT COUNT(*) as count FROM signals WHERE symbol IS NULL AND expires_at > NOW()`
  );
  if (parseInt(noSymbol?.count || 0) > 0) {
    log(WARN, 'Signals missing symbol field', `${noSymbol.count} will be skipped by Synthesizer`);
  }
}

async function auditRejectedOpportunities() {
  section('6. REJECTED OPPORTUNITIES (last 24h)');

  const rejections = await queryAll(`
    SELECT symbol, direction, confidence, rejection_reason, rejection_detail, COUNT(*) as count
    FROM rejected_opportunities
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY symbol, direction, confidence, rejection_reason, rejection_detail
    ORDER BY count DESC
    LIMIT 15
  `);

  if (rejections.length === 0) {
    log(INFO, 'No rejections in last 24h', '(could mean no proposals were made at all)');
    return;
  }

  // Count by reason category
  const compassBlocks = rejections.filter(r => r.rejection_detail?.includes('compass_posture_block') || r.rejection_detail?.includes('CASH') || r.rejection_detail?.includes('DEFENSIVE'));
  const drawdownBlocks = rejections.filter(r => r.rejection_detail?.includes('drawdown'));
  const confidenceBlocks = rejections.filter(r => r.rejection_detail?.includes('confidence'));
  const complexityBlocks = rejections.filter(r => r.rejection_detail?.includes('complexity'));

  if (compassBlocks.length > 0) {
    log(WARN, `COMPASS blocked ${compassBlocks.reduce((a,r)=>a+parseInt(r.count),0)} proposals`, 'posture gate is active');
  }
  if (drawdownBlocks.length > 0) {
    log(WARN, `Drawdown blocked ${drawdownBlocks.reduce((a,r)=>a+parseInt(r.count),0)} proposals`);
  }
  if (confidenceBlocks.length > 0) {
    log(INFO, `Low confidence blocked ${confidenceBlocks.reduce((a,r)=>a+parseInt(r.count),0)} proposals`);
  }
  if (complexityBlocks.length > 0) {
    log(INFO, `Low complexity blocked ${complexityBlocks.reduce((a,r)=>a+parseInt(r.count),0)} proposals`);
  }

  for (const r of rejections.slice(0, 8)) {
    log(INFO, `  ${r.symbol} ${r.direction} conf=${r.confidence}`, r.rejection_detail?.slice(0, 100));
  }
}

async function auditCycleHealth() {
  section('7. CYCLE HEALTH');

  try {
    const health = await queryOne(`
      SELECT system_name, status, last_cycle_at, error_count, metadata
      FROM platform_system_health
      WHERE system_name = 'grid'
      LIMIT 1
    `);

    if (!health) {
      log(WARN, 'No GRID health records', 'system may never have completed a cycle');
    } else {
      const ageH = (Date.now() - new Date(health.last_cycle_at).getTime()) / (1000 * 60 * 60);
      const meta = typeof health.metadata === 'string' ? JSON.parse(health.metadata) : (health.metadata || {});
      if (health.status !== 'healthy') {
        log(FAIL, `Last GRID cycle status: ${health.status}`, meta.error_message || '');
      } else if (ageH > 5) {
        log(WARN, 'Last GRID cycle was > 5h ago', `${Math.round(ageH)}h — expected every 4h`);
      } else {
        log(PASS, 'GRID cycle running normally', `last: ${Math.round(ageH)}h ago`);
      }
      if (health.error_count > 0) {
        log(WARN, `${health.error_count} consecutive errors recorded`);
      }
    }
  } catch (err) {
    log(WARN, 'Could not read cycle health', err.message);
  }

  // Bootstrap phase
  try {
    const bootstrap = await queryOne(
      `SELECT phase, entered_at FROM bootstrap_status ORDER BY id DESC LIMIT 1`
    );
    if (bootstrap) {
      log(INFO, 'Bootstrap phase', bootstrap.phase);
      if (bootstrap.phase === 'infant' || bootstrap.phase === 'learning') {
        log(WARN, 'PAPER_ONLY mode active', `bootstrap phase "${bootstrap.phase}" — live trades disabled`);
      }
    }
  } catch (err) {
    log(WARN, 'Could not read bootstrap status', err.message);
  }
}

async function auditOracleAlignment() {
  section('8. ORACLE ALIGNMENT');

  const theses = await queryAll(`
    SELECT payload, direction, conviction
    FROM intelligence_bus
    WHERE source_system = 'oracle'
      AND event_type = 'thesis_created'
      AND (expires_at IS NULL OR expires_at > NOW())
      AND superseded_by IS NULL
    ORDER BY created_at DESC
    LIMIT 10
  `);

  if (theses.length === 0) {
    log(INFO, 'No active ORACLE theses');
    return;
  }

  const bullish = theses.filter(t => t.direction === 'bull' || t.direction === 'long');
  const bearish = theses.filter(t => t.direction === 'bear' || t.direction === 'short');

  log(INFO, `${theses.length} active theses`, `${bullish.length} bullish, ${bearish.length} bearish`);

  // High-conviction bearish theses can trigger COMPASS CASH posture
  const highConvBearish = bearish.filter(t => parseFloat(t.conviction || 0) >= 8.5);
  if (highConvBearish.length > 0) {
    log(WARN, 'High-conviction bearish ORACLE theses active', `${highConvBearish.length} at >= 8.5 — these ban conflicting GRID longs`);
  }

  // Check for thesis payloads to extract names
  for (const t of theses.slice(0, 5)) {
    const p = typeof t.payload === 'string' ? JSON.parse(t.payload) : t.payload;
    const name = p?.thesis_name || p?.name || 'unnamed';
    log(INFO, `  ${t.direction || '?'} ${t.conviction}/10`, name.slice(0, 60));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '█'.repeat(55));
  console.log('  GRID BEHAVIORAL AUDIT');
  console.log(`  ${new Date().toISOString()}`);
  console.log('█'.repeat(55));

  try {
    await auditTradingActivity();
    await auditMarketRegime();
    await auditCompassPosture();
    await auditRiskGates();
    await auditSignalHealth();
    await auditRejectedOpportunities();
    await auditCycleHealth();
    await auditOracleAlignment();
  } catch (err) {
    console.error('\n[AUDIT ERROR]', err.message);
    process.exit(1);
  }

  console.log('\n' + '─'.repeat(55));
  console.log(`  SUMMARY: ${failures} failures, ${warnings} warnings`);

  if (failures > 0) {
    console.log('  ✗ System has CRITICAL issues — investigate before next cycle');
  } else if (warnings > 0) {
    console.log('  ⚠ System has warnings — review above');
  } else {
    console.log('  ✓ System looks healthy');
  }
  console.log('─'.repeat(55) + '\n');

  process.exit(failures > 0 ? 1 : 0);
}

main();
