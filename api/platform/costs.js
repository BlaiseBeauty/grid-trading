'use strict';

const aiCosts = require('../../shared/ai-costs');

module.exports = async function (fastify) {

  // GET /api/platform/costs/summary — monthly summary across all systems
  fastify.get('/costs/summary', {
    preHandler: fastify.authenticate,
  }, async (request, reply) => {
    const [summary, bySystem, byAgent] = await Promise.all([
      aiCosts.getMonthlySummary(),
      aiCosts.getBySystem(),
      aiCosts.getByAgent(),
    ]);

    return reply.send({
      month_to_date: {
        total_usd:     parseFloat(summary?.total_usd     || 0).toFixed(4),
        total_input:   parseInt(summary?.total_input     || 0),
        total_output:  parseInt(summary?.total_output    || 0),
        total_calls:   parseInt(summary?.total_calls     || 0),
        period_start:  summary?.period_start || null,
      },
      by_system:  bySystem.map(r => ({
        ...r,
        cost_usd:      parseFloat(r.cost_usd || 0).toFixed(4),
        input_tokens:  parseInt(r.input_tokens || 0),
        output_tokens: parseInt(r.output_tokens || 0),
        calls:         parseInt(r.calls || 0),
      })),
      by_agent: byAgent.map(r => ({
        ...r,
        cost_usd:      parseFloat(r.cost_usd || 0).toFixed(4),
        input_tokens:  parseInt(r.input_tokens || 0),
        output_tokens: parseInt(r.output_tokens || 0),
        calls:         parseInt(r.calls || 0),
        avg_input:     parseFloat(r.avg_input  || 0).toFixed(0),
        avg_output:    parseFloat(r.avg_output || 0).toFixed(0),
      })),
    });
  });

  // GET /api/platform/costs/daily?days=30 — daily cost breakdown
  fastify.get('/costs/daily', {
    preHandler: fastify.authenticate,
  }, async (request, reply) => {
    const days = Math.min(parseInt(request.query.days) || 30, 90);
    const rows = await aiCosts.getDailyCosts(days);

    return reply.send({
      days,
      rows: rows.map(r => ({
        day:          r.day,
        source_system: r.source_system,
        cost_usd:     parseFloat(r.cost_usd || 0).toFixed(4),
        calls:        parseInt(r.calls || 0),
      })),
    });
  });

  // GET /api/platform/costs/budget — budget status per tier
  fastify.get('/costs/budget', {
    preHandler: fastify.authenticate,
  }, async (request, reply) => {
    const budgets = aiCosts.TOKEN_BUDGETS;

    // Calculate theoretical max cost per cycle per tier
    const tiers = Object.entries(budgets).map(([tier, budget]) => {
      const model = tier.includes('synthesizer') || tier.includes('opus') ||
                    tier.includes('graveyard') || tier.includes('portfolio')
                    ? 'claude-opus' : 'claude-sonnet';
      const maxCostPerCall = aiCosts.calculateCost(
        model, budget.max_input, budget.max_output
      );
      return { tier, model, ...budget, max_cost_per_call_usd: maxCostPerCall.toFixed(6) };
    });

    return reply.send({ tiers, pricing: aiCosts.PRICING });
  });
};
