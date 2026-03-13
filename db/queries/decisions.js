const { queryAll, queryOne } = require('../connection');

async function getRecent({ limit = 50, agent_name } = {}) {
  if (agent_name) {
    return queryAll(
      'SELECT * FROM agent_decisions WHERE agent_name = $1 ORDER BY created_at DESC LIMIT $2',
      [agent_name, limit]
    );
  }
  return queryAll('SELECT * FROM agent_decisions ORDER BY created_at DESC LIMIT $1', [limit]);
}

async function getById(id) {
  return queryOne('SELECT * FROM agent_decisions WHERE id = $1', [id]);
}

async function create(decision) {
  const { agent_name, agent_layer, cycle_number, model_used,
    input_tokens, output_tokens, cost_usd, reasoning,
    confidence_score, output_json, duration_ms, error } = decision;

  return queryOne(`
    INSERT INTO agent_decisions (
      agent_name, agent_layer, cycle_number, model_used,
      input_tokens, output_tokens, cost_usd, reasoning,
      confidence_score, output_json, duration_ms, error
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *
  `, [agent_name, agent_layer, cycle_number, model_used,
    input_tokens, output_tokens, cost_usd, reasoning,
    confidence_score, JSON.stringify(output_json), duration_ms, error]);
}

async function getCostSummary() {
  return queryAll(`
    SELECT agent_name, agent_layer,
      COUNT(*) as total_calls,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(cost_usd), 0) as total_cost
    FROM agent_decisions
    GROUP BY agent_name, agent_layer
    ORDER BY total_cost DESC
  `);
}

async function getLastCycleNumber() {
  // Use COUNT of cycle_reports as the true cycle number — immune to historical
  // inflation from restarts that incremented an in-memory counter.
  // Each completed cycle writes exactly one report, so COUNT = actual cycles run.
  const row = await queryOne('SELECT COALESCE(COUNT(*), 0)::int as max_cycle FROM cycle_reports');
  return row?.max_cycle ?? 0;
}

module.exports = { getRecent, getById, create, getCostSummary, getLastCycleNumber };
