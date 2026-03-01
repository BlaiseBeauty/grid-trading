const { queryAll, queryOne } = require('../connection');

async function record({ service, agent_name, model, input_tokens, output_tokens, cost_usd, cycle_number }) {
  return queryOne(`
    INSERT INTO system_costs (service, agent_name, model, input_tokens, output_tokens, cost_usd, cycle_number)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *
  `, [service, agent_name, model, input_tokens, output_tokens, cost_usd, cycle_number]);
}

async function getSummary({ days = 30 } = {}) {
  return queryAll(`
    SELECT service,
      COUNT(*) as call_count,
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens
    FROM system_costs
    WHERE created_at > NOW() - INTERVAL '1 day' * $1
    GROUP BY service
    ORDER BY total_cost DESC
  `, [days]);
}

async function getDailyBreakdown({ days = 7 } = {}) {
  return queryAll(`
    SELECT DATE(created_at) as date,
      COALESCE(SUM(cost_usd), 0) as daily_cost,
      COUNT(*) as call_count
    FROM system_costs
    WHERE created_at > NOW() - INTERVAL '1 day' * $1
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `, [days]);
}

async function getTotalSpend() {
  return queryOne('SELECT COALESCE(SUM(cost_usd), 0) as total_spend FROM system_costs');
}

module.exports = { record, getSummary, getDailyBreakdown, getTotalSpend };
