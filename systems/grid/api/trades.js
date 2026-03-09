const tradesDb = require('../../../db/queries/trades');
const { queryAll, queryOne } = require('../../../db/connection');
const costsDb = require('../../../db/queries/costs');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic();
const bus = require('../../../shared/intelligence-bus');
const { linkTradeToTheses } = require('../../../shared/thesis-linker');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/trades', async (request) => {
    const { limit, offset, status, symbol } = request.query;
    return tradesDb.getAll({
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
      status,
      symbol,
    });
  });

  fastify.get('/trades/open', async () => {
    return tradesDb.getOpen();
  });

  fastify.get('/trades/stats', async () => {
    return tradesDb.getStats();
  });

  fastify.get('/trades/:id', async (request, reply) => {
    const trade = await tradesDb.getById(request.params.id);
    if (!trade) return reply.code(404).send({ error: 'Trade not found' });
    return trade;
  });

  fastify.post('/trades', {
    schema: {
      body: {
        type: 'object',
        required: ['symbol', 'side', 'quantity', 'entry_price'],
        properties: {
          symbol:            { type: 'string', minLength: 1 },
          asset_class:       { type: 'string' },
          exchange:          { type: 'string' },
          side:              { type: 'string', enum: ['buy', 'sell'] },
          quantity:          { type: 'number', exclusiveMinimum: 0 },
          entry_price:       { type: 'number', exclusiveMinimum: 0 },
          tp_price:          { type: ['number', 'null'] },
          sl_price:          { type: ['number', 'null'] },
          template_id:       { type: ['integer', 'null'] },
          execution_tier:    { type: 'string' },
          confidence:        { type: ['number', 'null'] },
          mode:              { type: 'string', enum: ['paper', 'live'] },
          cycle_number:      { type: ['integer', 'null'] },
          agent_decision_id: { type: ['integer', 'null'] },
          reasoning:         { type: ['string', 'null'] },
          bootstrap_phase:   { type: ['string', 'null'] },
          entry_confidence:  { type: ['number', 'null'] },
          kelly_optimal_pct: { type: ['number', 'null'] },
          kelly_inputs:      { type: ['object', 'null'] },
          complexity_score:  { type: ['number', 'null'] },
          signal_domains:    {},
          signal_timeframes: {},
        },
      },
    },
  }, async (request, reply) => {
    const trade = await tradesDb.create(request.body);
    fastify.broadcast('trade', trade);
    try {
      await bus.publish({
        source: 'grid', eventType: 'trade_executed',
        payload: { trade_id: trade.id, symbol: trade.symbol, side: trade.side, entry_price: trade.entry_price, quantity: trade.quantity, mode: trade.mode },
        affectedAssets: [trade.symbol], direction: trade.side === 'buy' ? 'long' : 'short',
      });
    } catch (e) { /* best-effort */ }
    return reply.code(201).send(trade);
  });

  // GET /api/trades/:id/signals — signals that contributed to this trade
  fastify.get('/trades/:id/signals', async (request) => {
    return queryAll(`
      SELECT ts.*, s.symbol, s.signal_type, s.signal_category, s.direction,
             s.strength, s.agent_name, s.reasoning, s.timeframe
      FROM trade_signals ts
      JOIN signals s ON s.id = ts.signal_id
      WHERE ts.trade_id = $1
      ORDER BY ts.created_at
    `, [request.params.id]);
  });

  // POST /api/trades/:id/explain — AI-generated trade explanation via Haiku
  fastify.post('/trades/:id/explain', {
    schema: { body: { type: 'object', properties: {} } },
  }, async (request, reply) => {
    const tradeId = request.params.id;

    // Assemble full context: trade + synthesizer output + regime + signals
    const context = await queryOne(`
      SELECT t.*,
        ad.output_json as synth_output,
        ad.reasoning as synth_reasoning,
        (SELECT row_to_json(r) FROM (
          SELECT regime, confidence, transition_probabilities
          FROM market_regime WHERE created_at <= t.opened_at
          ORDER BY created_at DESC LIMIT 1
        ) r) as regime_at_open,
        (SELECT json_agg(json_build_object(
          'agent', s.agent_name, 'type', s.signal_type,
          'category', s.signal_category, 'direction', s.direction,
          'strength', COALESCE(ts.strength_at_entry, s.strength), 'reasoning', s.reasoning
        )) FROM trade_signals ts
        JOIN signals s ON s.id = ts.signal_id
        WHERE ts.trade_id = t.id) as signals
      FROM trades t
      LEFT JOIN agent_decisions ad ON ad.id = t.agent_decision_id
      WHERE t.id = $1
    `, [tradeId]);

    if (!context) return reply.code(404).send({ error: 'Trade not found' });

    // Extract relevant fields for the prompt (avoid sending full raw reasoning)
    const promptData = {
      trade: {
        id: context.id, symbol: context.symbol, side: context.side,
        entry_price: context.entry_price, exit_price: context.exit_price,
        tp_price: context.tp_price, sl_price: context.sl_price,
        pnl_realised: context.pnl_realised, pnl_pct: context.pnl_pct,
        confidence: context.confidence, status: context.status,
        mode: context.mode, opened_at: context.opened_at, closed_at: context.closed_at,
        reasoning: context.reasoning,
      },
      regime: context.regime_at_open,
      signals: context.signals || [],
      synthesizer: context.synth_output ? {
        actions: context.synth_output.actions,
        standing_orders: context.synth_output.standing_orders,
        no_action_reasons: context.synth_output.no_action_reasons,
        market_assessment: context.synth_output.market_assessment,
        meta: context.synth_output.meta,
      } : null,
    };

    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: `You are GRID's trade narrator. Given the full context of an autonomous trade decision, write a 200-300 word explanation structured as:

1. REGIME — what regime was active, at what confidence, transition outlook
2. SIGNALS — what the knowledge agents detected, grouped by domain
3. THESIS — why the Synthesizer chose this symbol, direction, and template
4. REJECTED — what alternatives were considered and why they were passed
5. COUNTERFACTUAL — what would have had to be different for this trade to NOT happen (regime change, missing signals, anti-pattern trigger)

Write in clear direct prose. No bullet points. Reference specific signal types, strengths, and template names. Be precise about numbers.`,
        messages: [{ role: 'user', content: JSON.stringify(promptData) }],
      });

      const explanation = response.content[0]?.text || '';
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const costUsd = (inputTokens * 0.8 + outputTokens * 4.0) / 1_000_000;

      // Record cost
      try {
        await costsDb.record({
          service: 'anthropic', agent_name: 'trade_explainer',
          model: 'claude-haiku-4-5-20251001',
          input_tokens: inputTokens, output_tokens: outputTokens,
          cost_usd: costUsd, cycle_number: null,
        });
      } catch (e) { /* non-critical */ }

      return { explanation, model: 'claude-haiku-4-5-20251001', tokens: inputTokens + outputTokens, cost_usd: costUsd };
    } catch (err) {
      console.error('[EXPLAIN] Haiku call failed:', err.message);
      return reply.code(500).send({ error: 'Failed to generate explanation' });
    }
  });

  // H-14: Validate body before closing trade
  fastify.patch('/trades/:id/close', async (request, reply) => {
    const { exit_price, pnl_realised } = request.body || {};
    if (exit_price == null || isNaN(Number(exit_price)) || Number(exit_price) <= 0) {
      return reply.code(400).send({ error: 'exit_price is required and must be a positive number' });
    }
    if (pnl_realised == null || isNaN(Number(pnl_realised))) {
      return reply.code(400).send({ error: 'pnl_realised is required and must be a number' });
    }
    const trade = await tradesDb.closeTrade(request.params.id, request.body);
    if (!trade) return reply.code(404).send({ error: 'Trade not found or already closed' });
    fastify.broadcast('trade_closed', trade);
    try {
      await bus.publish({
        source: 'grid', eventType: 'trade_closed',
        payload: { trade_id: trade.id, symbol: trade.symbol, side: trade.side, exit_price: trade.exit_price, pnl_realised: trade.pnl_realised, pnl_pct: trade.pnl_pct },
        affectedAssets: [trade.symbol],
      });
    } catch (e) { /* best-effort */ }
    try {
      await linkTradeToTheses({
        id:           trade.id,
        symbol:       trade.symbol,
        side:         trade.side,
        pnl_usd:      trade.pnl_realised,
        pnl_pct:      trade.pnl_pct,
        close_reason: 'manual_close',
        hold_hours:   trade.opened_at ? (Date.now() - new Date(trade.opened_at)) / 3600000 : 0,
      });
    } catch (e) { /* thesis linking is non-critical */ }
    return trade;
  });
}

module.exports = routes;
