/**
 * Performance Analyst (Opus) — Reviews closed trades, extracts learnings,
 * identifies what's working and what isn't. The system's self-improvement engine.
 */

const BaseAgent = require('../base-agent');
const { queryAll, queryOne } = require('../../../../db/connection');
const learningsDb = require('../../../../db/queries/learnings');

class PerformanceAnalystAgent extends BaseAgent {
  constructor() {
    super({ name: 'performance_analyst', layer: 'analysis', model: 'claude-opus-4-6', costTier: 'grid_performance' });
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

    // Store extracted learnings (Claude returns "new_learnings" or "learnings")
    const parsed = result?.output_json || {};
    const learnings = parsed.new_learnings || parsed.learnings || [];
    for (const learning of learnings) {
      try {
        await learningsDb.create({
          insight_text: learning.insight_text || learning.insight,
          category: learning.category,
          confidence: learning.confidence,
          symbols: learning.symbols || [],
          asset_classes: learning.asset_classes || ['crypto'],
          supporting_trade_ids: learning.supporting_trade_ids || learning.trade_ids || [],
          source_agent: 'performance_analyst',
          evidence: learning.evidence || {},
          learning_type: learning.learning_type || learning.type || 'observation',
          scope_level: learning.scope_level || learning.scope || 'specific',
        });
      } catch (err) {
        console.error('[PERFORMANCE_ANALYST] Failed to store learning:', err.message);
      }
    }
    if (learnings.length > 0) {
      console.log(`[PERFORMANCE_ANALYST] Stored ${learnings.length} learnings`);
    }

    // Invalidate learnings if evidence contradicts them
    for (const inv of (parsed.invalidations || [])) {
      try {
        await learningsDb.invalidate(inv.learning_id, 'performance_analyst');
      } catch (err) {
        console.error('[PERFORMANCE_ANALYST] Failed to invalidate learning:', err.message);
      }
    }

    // Run lifecycle management after storing new learnings
    try {
      await this.advanceLearningStages();
    } catch (err) {
      console.error('[PERFORMANCE_ANALYST] advanceLearningStages failed:', err.message);
    }
    try {
      await this.detectConflicts();
    } catch (err) {
      console.error('[PERFORMANCE_ANALYST] detectConflicts failed:', err.message);
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

  /**
   * Advance learning stages based on statistical thresholds.
   * candidate → provisional: 5+ influenced trades, >55% win rate
   * provisional → active: tested in 2+ distinct regimes
   * active → decaying: decayed_confidence < 0.4 OR win rate < 45%
   * Also recomputes decayed_confidence for all non-invalidated learnings.
   */
  async advanceLearningStages() {
    // Map VARCHAR confidence to numeric for decay computation
    const CONF_MAP = { high: 0.85, med: 0.6, medium: 0.6, low: 0.3 };

    // 1. Recompute decayed_confidence for all non-invalidated learnings
    const allLearnings = await queryAll(`
      SELECT id, confidence, confidence_halflife_days, last_validated_at
      FROM learnings WHERE invalidated_at IS NULL AND stage != 'invalidated'
    `);

    for (const l of allLearnings) {
      const baseConf = CONF_MAP[l.confidence] || 0.5;
      const daysSinceValidated = l.last_validated_at
        ? (Date.now() - new Date(l.last_validated_at).getTime()) / (1000 * 60 * 60 * 24)
        : 0;
      const halflife = l.confidence_halflife_days || 14;
      const decayed = baseConf * Math.pow(0.5, daysSinceValidated / halflife);
      await queryOne(`UPDATE learnings SET decayed_confidence = $1 WHERE id = $2`, [
        Math.round(decayed * 1000) / 1000, l.id
      ]);
    }

    // 2. candidate → provisional: 5+ influenced trades AND win rate > 55%
    await queryAll(`
      UPDATE learnings SET stage = 'provisional', last_validated_at = NOW()
      WHERE stage = 'candidate'
        AND influenced_trades >= 5
        AND influenced_wins::float / NULLIF(influenced_trades, 0) > 0.55
    `);

    // 3. provisional → active: tested in 2+ distinct regimes
    await queryAll(`
      UPDATE learnings SET stage = 'active', last_validated_at = NOW()
      WHERE stage = 'provisional'
        AND (SELECT COUNT(DISTINCT key) FROM jsonb_each(COALESCE(regime_breakdown, '{}'))) >= 2
    `);

    // 4. active → decaying: decayed_confidence < 0.4 OR win rate < 45%
    await queryAll(`
      UPDATE learnings SET stage = 'decaying'
      WHERE stage = 'active'
        AND (
          decayed_confidence < 0.4
          OR (influenced_trades >= 5 AND influenced_wins::float / NULLIF(influenced_trades, 0) < 0.45)
        )
    `);

    // 5. decaying → invalidated: win rate < 35% over 10+ trades
    await queryAll(`
      UPDATE learnings SET stage = 'invalidated', invalidated_at = NOW(),
        invalidation_reason = 'auto: win_rate < 35% over 10+ trades'
      WHERE stage = 'decaying'
        AND influenced_trades >= 10
        AND influenced_wins::float / NULLIF(influenced_trades, 0) < 0.35
    `);

    console.log('[PERFORMANCE_ANALYST] Learning stages updated');
  }

  /**
   * Detect conflicting learnings via word overlap with opposite directional keywords.
   */
  async detectConflicts() {
    const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'in', 'of', 'to', 'for', 'and', 'or', 'with', 'on', 'at', 'by', 'it', 'be', 'as', 'that', 'this', 'was', 'are', 'not', 'but', 'has', 'had', 'have']);
    const BULLISH = new Set(['bullish', 'long', 'buy', 'upward', 'breakout', 'support', 'accumulation', 'oversold']);
    const BEARISH = new Set(['bearish', 'short', 'sell', 'downward', 'breakdown', 'resistance', 'distribution', 'overbought']);

    function getWords(text) {
      if (!text) return [];
      return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
    }

    function getDirection(words) {
      const bull = words.filter(w => BULLISH.has(w)).length;
      const bear = words.filter(w => BEARISH.has(w)).length;
      if (bull > bear) return 'bullish';
      if (bear > bull) return 'bearish';
      return 'neutral';
    }

    const activeLearnings = await queryAll(`
      SELECT id, insight_text FROM learnings
      WHERE stage IN ('active', 'provisional') AND invalidated_at IS NULL
    `);

    let detected = 0;
    for (let i = 0; i < activeLearnings.length; i++) {
      const wordsA = getWords(activeLearnings[i].insight_text);
      const dirA = getDirection(wordsA);
      if (dirA === 'neutral') continue;

      for (let j = i + 1; j < activeLearnings.length; j++) {
        const wordsB = getWords(activeLearnings[j].insight_text);
        const dirB = getDirection(wordsB);
        if (dirB === 'neutral' || dirA === dirB) continue;

        // Check word overlap > 40%
        const setA = new Set(wordsA);
        const overlap = wordsB.filter(w => setA.has(w));
        const overlapPct = overlap.length / Math.min(wordsA.length, wordsB.length);

        if (overlapPct > 0.4) {
          try {
            await queryOne(`
              INSERT INTO learning_conflicts (learning_a_id, learning_b_id, conflict_type, similarity_score)
              VALUES ($1, $2, 'directional', $3)
              ON CONFLICT (learning_a_id, learning_b_id) DO NOTHING
            `, [activeLearnings[i].id, activeLearnings[j].id, Math.round(overlapPct * 100) / 100]);

            // Update conflict_ids arrays on both learnings
            await queryOne(`UPDATE learnings SET conflict_ids = array_append(conflict_ids, $2) WHERE id = $1 AND NOT ($2 = ANY(conflict_ids))`, [activeLearnings[i].id, activeLearnings[j].id]);
            await queryOne(`UPDATE learnings SET conflict_ids = array_append(conflict_ids, $2) WHERE id = $1 AND NOT ($2 = ANY(conflict_ids))`, [activeLearnings[j].id, activeLearnings[i].id]);
            detected++;
          } catch (err) {
            // UNIQUE violation means already detected — ignore
          }
        }
      }
    }

    if (detected > 0) {
      console.log(`[PERFORMANCE_ANALYST] Detected ${detected} new learning conflicts`);
    }
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
