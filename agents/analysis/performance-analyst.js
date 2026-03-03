/**
 * Performance Analyst (Opus) — Reviews closed trades, extracts learnings,
 * identifies what's working and what isn't. The system's self-improvement engine.
 */

const BaseAgent = require('../base-agent');
const { queryAll, queryOne } = require('../../db/connection');
const learningsDb = require('../../db/queries/learnings');

class PerformanceAnalystAgent extends BaseAgent {
  constructor() {
    super({ name: 'performance_analyst', layer: 'analysis', model: 'claude-opus-4-6' });
  }

  /**
   * Override run — reviews recent closed trades and system performance.
   */
  async run({ cycleNumber, broadcast }) {
    const context = await this.gatherPerformanceContext();

    // Skip if no trades to analyse
    if (context.recentTrades.length === 0 && context.unanalysedTrades.length === 0) {
      console.log('[PERFORMANCE_ANALYST] No trades to analyse — skipping');
      return null;
    }

    const result = await super.run({
      symbols: [],
      indicators: {},
      marketData: {},
      cycleNumber,
      _analysisContext: context,
    });

    // Store extracted learnings
    const parsed = result?.output_json || {};
    for (const learning of (parsed.learnings || [])) {
      try {
        await learningsDb.create({
          insight_text: learning.insight,
          category: learning.category,
          confidence: learning.confidence,
          symbols: learning.symbols || [],
          asset_classes: learning.asset_classes || ['crypto'],
          supporting_trade_ids: learning.trade_ids || [],
          source_agent: 'performance_analyst',
          evidence: learning.evidence || {},
          learning_type: learning.type || 'observation',
          scope_level: learning.scope || 'specific',
        });
      } catch (err) {
        console.error('[PERFORMANCE_ANALYST] Failed to store learning:', err.message);
      }
    }

    // Invalidate learnings if evidence contradicts them
    for (const inv of (parsed.invalidations || [])) {
      try {
        await learningsDb.invalidate(inv.learning_id, 'performance_analyst');
      } catch (err) {
        console.error('[PERFORMANCE_ANALYST] Failed to invalidate learning:', err.message);
      }
    }

    return result;
  }

  async gatherPerformanceContext() {
    const [recentTrades, unanalysedTrades, tradeStats, signalAccuracy,
           templatePerformance, existingLearnings, regimeHistory] = await Promise.all([
      // Last 20 closed trades
      queryAll(`
        SELECT t.*,
          ARRAY_AGG(DISTINCT s.signal_type) FILTER (WHERE s.signal_type IS NOT NULL) as signal_types,
          ARRAY_AGG(DISTINCT s.agent_name) FILTER (WHERE s.agent_name IS NOT NULL) as contributing_agents
        FROM trades t
        LEFT JOIN trade_signals ts ON t.id = ts.trade_id
        LEFT JOIN signals s ON ts.signal_id = s.id
        WHERE t.status = 'closed'
        GROUP BY t.id
        ORDER BY t.closed_at DESC
        LIMIT 20
      `),

      // Trades closed since last analysis run
      queryAll(`
        SELECT t.*
        FROM trades t
        WHERE t.status = 'closed'
          AND t.closed_at > COALESCE(
            (SELECT MAX(created_at) FROM agent_decisions WHERE agent_name = 'performance_analyst'),
            '1970-01-01'
          )
        ORDER BY t.closed_at DESC
      `),

      // Aggregate stats
      queryOne(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'closed') as total_trades,
          COUNT(*) FILTER (WHERE pnl_realised > 0) as wins,
          COUNT(*) FILTER (WHERE pnl_realised < 0) as losses,
          COUNT(*) FILTER (WHERE pnl_realised = 0) as breakeven,
          COALESCE(SUM(pnl_realised), 0) as total_pnl,
          ROUND(AVG(pnl_pct) FILTER (WHERE status = 'closed'), 2) as avg_return_pct,
          ROUND(AVG(pnl_pct) FILTER (WHERE pnl_realised > 0), 2) as avg_win_pct,
          ROUND(AVG(pnl_pct) FILTER (WHERE pnl_realised < 0), 2) as avg_loss_pct,
          ROUND(AVG(EXTRACT(EPOCH FROM (closed_at - opened_at)) / 3600), 1) as avg_hold_hours,
          MAX(pnl_realised) as best_trade,
          MIN(pnl_realised) as worst_trade
        FROM trades
      `),

      // Signal accuracy — which signal types lead to profitable trades?
      queryAll(`
        SELECT
          s.signal_type,
          s.agent_name,
          COUNT(*) as trade_count,
          ROUND(100.0 * COUNT(*) FILTER (WHERE t.pnl_realised > 0) / NULLIF(COUNT(*), 0), 1) as win_rate,
          ROUND(AVG(t.pnl_pct), 2) as avg_pnl_pct
        FROM trade_signals ts
        JOIN signals s ON ts.signal_id = s.id
        JOIN trades t ON ts.trade_id = t.id
        WHERE t.status = 'closed'
        GROUP BY s.signal_type, s.agent_name
        HAVING COUNT(*) >= 2
        ORDER BY win_rate DESC
      `),

      // Template performance
      queryAll(`
        SELECT
          st.name as template_name,
          st.status as template_status,
          tp.total_trades,
          tp.win_rate, tp.avg_return_pct, tp.profit_factor,
          tp.sharpe, tp.max_drawdown
        FROM strategy_templates st
        LEFT JOIN template_performance tp ON st.id = tp.template_id
        WHERE st.trade_count > 0
        ORDER BY tp.win_rate DESC NULLS LAST
      `),

      // Existing learnings (to avoid duplicates and check for contradictions)
      queryAll(`
        SELECT * FROM learnings
        WHERE invalidated_at IS NULL
        ORDER BY created_at DESC
        LIMIT 30
      `),

      // Recent regime transitions
      queryAll(`
        SELECT * FROM market_regime
        ORDER BY created_at DESC
        LIMIT 10
      `),
    ]);

    return {
      recentTrades,
      unanalysedTrades,
      tradeStats,
      signalAccuracy,
      templatePerformance,
      existingLearnings,
      regimeHistory,
    };
  }

  parseOutput(text) {
    try {
      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        return { ...parsed, signals: [], overallConfidence: null };
      }
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) return { ...JSON.parse(trimmed), signals: [] };
    } catch (err) { console.warn('[PERF_ANALYST] JSON parse failed in parseOutput:', err.message); }
    return { learnings: [], invalidations: [], signals: [], overallConfidence: null };
  }
}

module.exports = PerformanceAnalystAgent;
