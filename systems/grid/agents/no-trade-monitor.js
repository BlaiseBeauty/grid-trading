'use strict';

/**
 * No-Trade Monitor — fires an alert when GRID hasn't traded in 48h
 * while market conditions suggest it should be.
 *
 * Checks:
 *  1. Hours since last trade
 *  2. Current market regime
 *  3. COMPASS posture + why it's set
 *  4. Active signals count
 *  5. Recent rejected opportunities
 *
 * Called from the hourly cron in server.js.
 */

const { queryOne, queryAll } = require('../../../db/connection');
const { notify }             = require('../../../shared/notifications');

const NO_TRADE_WARN_HOURS   = 48;  // warn after 48h with no trades
const BULLISH_REGIME        = 'trending_up';

async function checkNoTradeSituation() {
  // 1. When was the last trade?
  const lastTrade = await queryOne(`
    SELECT opened_at, symbol, side
    FROM trades
    ORDER BY opened_at DESC
    LIMIT 1
  `);

  const hoursSinceTrade = lastTrade
    ? (Date.now() - new Date(lastTrade.opened_at).getTime()) / (1000 * 60 * 60)
    : Infinity;

  if (hoursSinceTrade < NO_TRADE_WARN_HOURS) return; // nothing to alert about

  // 2. What's the current regime?
  const regimeRow = await queryOne(
    `SELECT regime, confidence, created_at FROM market_regime ORDER BY created_at DESC LIMIT 1`
  );
  const regime        = regimeRow?.regime || 'unknown';
  const regimeAge     = regimeRow
    ? Math.round((Date.now() - new Date(regimeRow.created_at).getTime()) / (1000 * 60 * 60))
    : null;

  // 3. COMPASS posture (from intelligence bus)
  const compassEvent = await queryOne(`
    SELECT payload, created_at
    FROM intelligence_bus
    WHERE source_system = 'compass'
      AND event_type IN ('allocation_guidance', 'portfolio_risk_state')
      AND (expires_at IS NULL OR expires_at > NOW())
      AND superseded_by IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `);
  let compassPosture = 'unknown';
  let compassReason  = '';
  if (compassEvent?.payload) {
    const p = typeof compassEvent.payload === 'string'
      ? JSON.parse(compassEvent.payload) : compassEvent.payload;
    compassPosture = p?.risk_posture || 'unknown';
    compassReason  = p?.posture_reasoning || '';
  }

  // 4. Active signals count
  const signalCount = await queryOne(
    `SELECT COUNT(*) as count FROM signals WHERE expires_at > NOW()`
  );
  const activeSignals = parseInt(signalCount?.count || 0);

  // 5. Recent rejected opportunities (last 24h)
  const recentRejections = await queryAll(`
    SELECT symbol, direction, confidence, rejection_reason, rejection_detail, created_at
    FROM rejected_opportunities
    WHERE created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC
    LIMIT 10
  `);

  // 6. Last cycle completion
  const lastCycle = await queryOne(`
    SELECT last_cycle_at, status, error_message
    FROM system_health
    WHERE system_name = 'grid'
    ORDER BY last_cycle_at DESC
    LIMIT 1
  `);

  // Build alert body
  const isBullish   = regime === BULLISH_REGIME;
  const urgency     = isBullish ? 'warning' : 'info';
  const hoursLabel  = hoursSinceTrade === Infinity
    ? 'never traded'
    : `${Math.round(hoursSinceTrade)}h ago`;

  const rejectionSummary = recentRejections.length > 0
    ? recentRejections.map(r =>
        `${r.symbol} ${r.direction} (conf=${r.confidence}): ${r.rejection_detail}`
      ).join(' | ')
    : 'none in last 24h';

  const body = [
    `Last trade: ${hoursLabel}`,
    `Regime: ${regime}${regimeAge !== null ? ` (${regimeAge}h old)` : ''}`,
    `COMPASS posture: ${compassPosture}${compassReason ? ` — ${compassReason.slice(0, 120)}` : ''}`,
    `Active signals: ${activeSignals}`,
    `Recent rejections: ${rejectionSummary}`,
    lastCycle ? `Last cycle: ${lastCycle.status} at ${new Date(lastCycle.last_cycle_at).toISOString()}` : 'No cycle data',
  ].join('\n');

  const title = isBullish
    ? `⚠ No trades for ${Math.round(hoursSinceTrade)}h — market is BULLISH (${regime})`
    : `No trades for ${Math.round(hoursSinceTrade)}h — regime: ${regime}`;

  // Deduplicate — don't fire the same alert more than once per 6h
  const recentAlert = await queryOne(`
    SELECT id FROM platform_notifications
    WHERE type = 'no_trade_alert'
      AND created_at > NOW() - INTERVAL '6 hours'
    LIMIT 1
  `);

  if (recentAlert) {
    console.log(`[NO-TRADE-MONITOR] Alert suppressed — already fired within last 6h`);
    return;
  }

  await notify({
    source:   'grid',
    type:     'no_trade_alert',
    title,
    body,
    urgency,
    metadata: {
      hours_since_trade:  Math.round(hoursSinceTrade),
      regime,
      compass_posture:    compassPosture,
      active_signals:     activeSignals,
      rejection_count_24h: recentRejections.length,
    },
  });

  console.log(`[NO-TRADE-MONITOR] Alert fired: ${title}`);
}

module.exports = { checkNoTradeSituation };
