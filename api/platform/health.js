// Platform Health API — system health, bus stats, AI costs
const { queryAll, queryOne } = require('../../db/connection');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/platform/health — aggregated platform health
  fastify.get('/health', async () => {
    const [systemHealth, busStats, aiCosts] = await Promise.all([
      // System health for all registered systems
      queryAll('SELECT * FROM platform_system_health ORDER BY system_name'),

      // Bus stats: count of active events by source
      queryOne(`
        SELECT
          COUNT(*) FILTER (WHERE source_system = 'grid')::int as grid_events,
          COUNT(*) FILTER (WHERE source_system = 'compass')::int as compass_events,
          COUNT(*) FILTER (WHERE source_system = 'oracle')::int as oracle_events,
          COUNT(*)::int as total_events
        FROM intelligence_bus
        WHERE superseded_by IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
      `),

      // AI costs: last 24h by system
      queryAll(`
        SELECT source_system,
               SUM(cost_usd)::numeric(10,4) as total_cost,
               SUM(input_tokens)::int as total_input_tokens,
               SUM(output_tokens)::int as total_output_tokens,
               COUNT(*)::int as call_count
        FROM platform_ai_costs
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY source_system
        ORDER BY source_system
      `),
    ]);

    return {
      systems: systemHealth,
      intelligence_bus: busStats || { grid_events: 0, compass_events: 0, oracle_events: 0, total_events: 0 },
      ai_costs_24h: aiCosts,
      timestamp: Date.now(),
    };
  });
}

module.exports = routes;
