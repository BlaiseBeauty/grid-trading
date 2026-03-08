const { queryAll, queryOne, query } = require('../connection');

async function fetchActive() {
  return queryAll(`
    SELECT * FROM standing_orders WHERE status = 'active' AND expires_at > NOW()
  `);
}

async function claimOrder(id) {
  return query(
    `UPDATE standing_orders SET status = 'triggered', triggered_at = NOW()
     WHERE id = $1 AND status = 'active' RETURNING id`,
    [id]
  );
}

async function linkTrade(id, tradeId) {
  return query(
    `UPDATE standing_orders SET status = 'executed', executed_at = NOW(), trade_id = $2
     WHERE id = $1`,
    [id, tradeId]
  );
}

async function revertToActive(id) {
  return query(
    `UPDATE standing_orders SET status = 'active'
     WHERE id = $1 AND status = 'triggered'`,
    [id]
  );
}

async function markFailed(id, reason) {
  return query(
    `UPDATE standing_orders SET status = 'failed', failure_reason = $2, failed_at = NOW()
     WHERE id = $1 AND status IN ('triggered', 'active')`,
    [id, reason || 'execution_failed']
  );
}

async function markPendingRetry(id, reason) {
  return query(
    `UPDATE standing_orders SET status = 'pending_retry', failure_reason = $2, failed_at = NOW()
     WHERE id = $1 AND status = 'triggered'`,
    [id, reason || 'transient_failure']
  );
}

async function retryPending() {
  return query(`
    UPDATE standing_orders SET status = 'active', failure_reason = NULL, failed_at = NULL
    WHERE status = 'pending_retry' AND failed_at < NOW() - INTERVAL '15 minutes'
  `);
}

async function expireOld() {
  return query(`
    UPDATE standing_orders SET status = 'expired'
    WHERE status = 'active' AND expires_at < NOW()
  `);
}

async function createFromSynthesizer({ agentName, agentDecisionId, symbol, side, conditions, executionParams, confidence, expiresHours }) {
  return query(`
    INSERT INTO standing_orders (
      created_by_agent, agent_decision_id, symbol, asset_class, side,
      conditions, execution_params, confidence,
      expires_at
    ) VALUES (
      $1, $2, $3, 'crypto', $4,
      $5, $6, $7,
      NOW() + make_interval(hours => $8)
    )
  `, [agentName, agentDecisionId, symbol, side,
      JSON.stringify(conditions), JSON.stringify(executionParams),
      confidence, expiresHours]);
}

module.exports = { fetchActive, claimOrder, linkTrade, revertToActive, markFailed, markPendingRetry, retryPending, expireOld, createFromSynthesizer };
