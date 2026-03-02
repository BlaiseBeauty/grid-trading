const { query } = require('../connection');

async function insert(review, cycleNumber, agentDecisionId) {
  return query(`
    INSERT INTO position_reviews (
      trade_id, cycle_number, agent_decision_id, decision, reasoning,
      current_price, unrealised_pnl, unrealised_pnl_pct, hours_held,
      old_tp, old_sl, new_tp, new_sl,
      close_executed, partial_close_pct, regime_at_review, signals_summary
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
  `, [
    review.trade_id, cycleNumber, agentDecisionId || null,
    review.decision, review.reasoning,
    review.current_price || null, review.unrealised_pnl || null,
    review.unrealised_pnl_pct || null, review.hours_held || null,
    review.old_tp || null, review.old_sl || null,
    review.new_tp || null, review.new_sl || null,
    review.close_executed || false, review.close_pct || null,
    review.regime_at_review || null,
    review.signals_summary ? JSON.stringify(review.signals_summary) : null,
  ]);
}

module.exports = { insert };
