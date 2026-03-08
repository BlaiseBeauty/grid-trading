// Platform Notifications — unified notification system across all systems
// Writes to platform_notifications table (separate from GRID's existing webhook-based notification_log)
const { queryAll, queryOne, query } = require('../db/connection');

/**
 * Create a platform notification.
 * @param {Object} opts
 * @param {string} opts.source - 'grid' | 'compass' | 'oracle' | 'platform'
 * @param {string} opts.type - notification type (e.g. 'scram', 'trade_closed')
 * @param {string} opts.title - short title
 * @param {string} [opts.body] - longer description
 * @param {string} [opts.urgency] - 'info' | 'warning' | 'critical'
 * @param {Object} [opts.metadata] - arbitrary JSON metadata
 */
async function notify({ source, type, title, body = '', urgency = 'info', metadata = {} }) {
  return queryOne(`
    INSERT INTO platform_notifications (source_system, type, title, body, urgency, metadata)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [source, type, title, body, urgency, JSON.stringify(metadata)]);
}

/** Notify SCRAM activation */
async function notifyScram(level) {
  return notify({
    source: 'grid', type: 'scram', urgency: 'critical',
    title: `SCRAM ${level.toUpperCase()} Activated`,
    body: `Trading restrictions in effect. Level: ${level}`,
    metadata: { level },
  });
}

/** Notify trade closed */
async function notifyTradeClosed(trade) {
  const won = parseFloat(trade.pnl_realised) >= 0;
  return notify({
    source: 'grid', type: 'trade_closed', urgency: 'info',
    title: `Trade Closed: ${trade.symbol} ${won ? 'WIN' : 'LOSS'}`,
    body: `P&L: $${parseFloat(trade.pnl_realised).toFixed(2)} (${parseFloat(trade.pnl_pct).toFixed(2)}%)`,
    metadata: { trade_id: trade.id, symbol: trade.symbol, pnl: trade.pnl_realised },
  });
}

/** Notify new thesis (ORACLE) */
async function notifyNewThesis(thesis) {
  return notify({
    source: 'oracle', type: 'new_thesis', urgency: 'info',
    title: `New Thesis: ${thesis.title || thesis.symbol}`,
    body: thesis.summary || '',
    metadata: { thesis_id: thesis.id },
  });
}

/** Get recent notifications */
async function getRecent({ limit = 50, source } = {}) {
  if (source) {
    return queryAll(
      'SELECT * FROM platform_notifications WHERE source_system = $1 ORDER BY created_at DESC LIMIT $2',
      [source, limit]
    );
  }
  return queryAll(
    'SELECT * FROM platform_notifications ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
}

/** Get unread notifications */
async function getUnread() {
  return queryAll(
    'SELECT * FROM platform_notifications WHERE read_at IS NULL ORDER BY created_at DESC'
  );
}

/** Mark a single notification as read */
async function markRead(id) {
  return queryOne(
    'UPDATE platform_notifications SET read_at = NOW() WHERE id = $1 RETURNING *',
    [id]
  );
}

/** Mark all notifications as read */
async function markAllRead() {
  const result = await query(
    'UPDATE platform_notifications SET read_at = NOW() WHERE read_at IS NULL'
  );
  return { marked: result.rowCount };
}

module.exports = { notify, notifyScram, notifyTradeClosed, notifyNewThesis, getRecent, getUnread, markRead, markAllRead };
