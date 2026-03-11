/**
 * Pattern Discovery (Opus) — Discovers recurring signal combinations that lead
 * to profitable trades, creates strategy templates, manages template lifecycle
 * (draft → testing → active → retired), and identifies anti-patterns.
 */

const BaseAgent = require('../base-agent');
const { queryAll, queryOne, query } = require('../../../../db/connection');
const templatesDb = require('../../../../db/queries/templates');
const { persistPatterns } = require('../pattern-store');

class PatternDiscoveryAgent extends BaseAgent {
  constructor() {
    super({ name: 'pattern_discovery', layer: 'analysis', model: 'claude-opus-4-6', costTier: 'grid_pattern' });
  }

  /**
   * Override run — analyses trade history for recurring patterns.
   */
  async run({ cycleNumber, broadcast }) {
    const context = await this.gatherPatternContext();

    // Skip if insufficient data
    if (context.closedTrades.length < 3) {
      console.log('[PATTERN_DISCOVERY] Insufficient trade data — skipping');
      return null;
    }

    const result = await super.run({
      symbols: [],
      indicators: {},
      marketData: {},
      cycleNumber,
      _patternContext: context,
    });

    // Execute pattern actions
    const parsed = result?.output_json || {};

    // Create new templates
    for (const template of (parsed.new_templates || [])) {
      try {
        await templatesDb.create({
          name: template.name,
          description: template.description,
          entry_conditions: template.entry_conditions,
          exit_conditions: template.exit_conditions,
          valid_regimes: template.valid_regimes,
          valid_asset_classes: template.valid_asset_classes || ['crypto'],
          valid_symbols: template.valid_symbols || [],
          source: 'pattern_discovery',
        });
        console.log(`[PATTERN_DISCOVERY] Created template: ${template.name}`);
      } catch (err) {
        console.error(`[PATTERN_DISCOVERY] Failed to create template "${template.name}":`, err.message);
      }
    }

    // Promote/retire templates
    for (const action of (parsed.template_actions || [])) {
      try {
        if (action.template_id && action.new_status) {
          await templatesDb.updateStatus(action.template_id, action.new_status);
          console.log(`[PATTERN_DISCOVERY] Template #${action.template_id} → ${action.new_status}`);
        }
      } catch (err) {
        console.error(`[PATTERN_DISCOVERY] Template action failed:`, err.message);
      }
    }

    // Create/update anti-patterns
    for (const ap of (parsed.anti_patterns || [])) {
      try {
        await this.upsertAntiPattern(ap);
      } catch (err) {
        console.error(`[PATTERN_DISCOVERY] Anti-pattern upsert failed:`, err.message);
      }
    }

    // Update template performance stats
    for (const perf of (parsed.performance_updates || [])) {
      try {
        await this.updateTemplatePerformance(perf);
      } catch (err) {
        console.error(`[PATTERN_DISCOVERY] Performance update failed:`, err.message);
      }
    }

    // Persist discovered signal patterns to grid_signal_patterns
    try {
      const rawOutput = result?.output_json?._raw || JSON.stringify(parsed);
      const jsonStart = rawOutput.indexOf('{');
      const jsonEnd   = rawOutput.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const patternData = JSON.parse(rawOutput.slice(jsonStart, jsonEnd + 1));
        if (patternData.patterns?.length > 0) {
          await persistPatterns(patternData.patterns);
        }
      }
    } catch { /* pattern persistence is non-critical */ }

    // Also extract patterns from signal combinations data
    try {
      const combos = context.signalCombinations || [];
      const patternPayloads = combos
        .filter(c => parseInt(c.co_occurrence_count) >= 5)
        .map(c => ({
          pattern_id: `pattern-combo-${c.signal_a}-${c.signal_b}`.toLowerCase(),
          symbol: 'ALL',
          signal_types: [c.signal_a, c.signal_b],
          signal_direction: parseFloat(c.avg_pnl_together) >= 0 ? 'bullish' : 'bearish',
          sample_trades: parseInt(c.co_occurrence_count),
          win_rate: parseFloat(c.win_rate_together || 0),
          avg_pnl_pct: parseFloat(c.avg_pnl_together || 0),
          confidence: parseInt(c.co_occurrence_count) >= 15 && parseFloat(c.win_rate_together) >= 65 ? 'confirmed' : 'emerging',
          description: `${c.signal_a} + ${c.signal_b} co-occurrence (${c.co_occurrence_count} trades, ${c.win_rate_together}% WR)`,
        }));
      if (patternPayloads.length > 0) {
        await persistPatterns(patternPayloads);
      }
    } catch { /* pattern extraction is non-critical */ }

    return result;
  }

  async gatherPatternContext() {
    const [closedTrades, signalCombinations, existingTemplates,
           antiPatterns, regimePerformance, rejectedOpportunities] = await Promise.all([
      // All closed trades with their signals
      queryAll(`
        SELECT
          t.*,
          ARRAY_AGG(DISTINCT s.signal_type) FILTER (WHERE s.signal_type IS NOT NULL) as signal_types,
          ARRAY_AGG(DISTINCT s.agent_name) FILTER (WHERE s.agent_name IS NOT NULL) as agents,
          ARRAY_AGG(DISTINCT s.signal_category) FILTER (WHERE s.signal_category IS NOT NULL) as domains
        FROM trades t
        LEFT JOIN trade_signals ts ON t.id = ts.trade_id
        LEFT JOIN signals s ON ts.signal_id = s.id
        WHERE t.status = 'closed'
        GROUP BY t.id
        ORDER BY t.closed_at DESC
        LIMIT 100
      `),

      // Signal co-occurrence in trades
      queryAll(`
        SELECT
          s1.signal_type as signal_a,
          s2.signal_type as signal_b,
          COUNT(DISTINCT ts1.trade_id) as co_occurrence_count,
          ROUND(100.0 * COUNT(DISTINCT ts1.trade_id) FILTER (WHERE t.pnl_realised > 0) /
            NULLIF(COUNT(DISTINCT ts1.trade_id), 0), 1) as win_rate_together,
          ROUND(AVG(t.pnl_pct), 2) as avg_pnl_together
        FROM trade_signals ts1
        JOIN signals s1 ON ts1.signal_id = s1.id
        JOIN trade_signals ts2 ON ts1.trade_id = ts2.trade_id AND ts1.id < ts2.id
        JOIN signals s2 ON ts2.signal_id = s2.id AND s1.signal_type < s2.signal_type
        JOIN trades t ON ts1.trade_id = t.id AND t.status = 'closed'
        GROUP BY s1.signal_type, s2.signal_type
        HAVING COUNT(DISTINCT ts1.trade_id) >= 2
        ORDER BY win_rate_together DESC
      `),

      // Current templates
      queryAll(`
        SELECT st.*, tp.win_rate, tp.total_trades, tp.profit_factor,
          tp.avg_return_pct, tp.sharpe, tp.max_drawdown
        FROM strategy_templates st
        LEFT JOIN template_performance tp ON st.id = tp.template_id
        ORDER BY st.created_at DESC
      `),

      // Existing anti-patterns
      queryAll('SELECT * FROM anti_patterns WHERE active = true'),

      // Performance by regime
      queryAll(`
        SELECT
          mr.regime,
          mr.confidence as regime_confidence,
          COUNT(t.id) as trade_count,
          ROUND(100.0 * COUNT(*) FILTER (WHERE t.pnl_realised > 0) /
            NULLIF(COUNT(*), 0), 1) as win_rate,
          ROUND(AVG(t.pnl_pct), 2) as avg_pnl_pct
        FROM trades t
        JOIN market_regime mr ON mr.asset_class = t.asset_class
          AND mr.created_at <= t.opened_at
          AND mr.created_at > t.opened_at - INTERVAL '4 hours'
        WHERE t.status = 'closed'
        GROUP BY mr.regime, mr.confidence
        HAVING COUNT(t.id) >= 2
        ORDER BY trade_count DESC
      `),

      // Rejected opportunities that would have been profitable
      queryAll(`
        SELECT ro.*, md.close as current_price
        FROM rejected_opportunities ro
        LEFT JOIN LATERAL (
          SELECT close FROM market_data
          WHERE symbol = ro.symbol
          ORDER BY timestamp DESC LIMIT 1
        ) md ON true
        WHERE ro.created_at > NOW() - INTERVAL '7 days'
        ORDER BY ro.created_at DESC
        LIMIT 20
      `),
    ]);

    return {
      closedTrades,
      signalCombinations,
      existingTemplates,
      antiPatterns,
      regimePerformance,
      rejectedOpportunities,
    };
  }

  async upsertAntiPattern(ap) {
    const existing = await queryOne(
      'SELECT id FROM anti_patterns WHERE name = $1',
      [ap.name]
    );

    if (existing) {
      await query(`
        UPDATE anti_patterns SET
          signal_combination = $2, lose_rate = $3, sample_size = $4,
          description = $5, active = $6, updated_at = NOW()
        WHERE id = $1
      `, [existing.id, JSON.stringify(ap.signal_combination), ap.lose_rate,
          ap.sample_size, ap.description, ap.active !== false]);
    } else {
      await query(`
        INSERT INTO anti_patterns (name, signal_combination, lose_rate, sample_size, description, active)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [ap.name, JSON.stringify(ap.signal_combination), ap.lose_rate,
          ap.sample_size, ap.description, ap.active !== false]);
    }
  }

  async updateTemplatePerformance(perf) {
    const existing = await queryOne(
      'SELECT id FROM template_performance WHERE template_id = $1',
      [perf.template_id]
    );

    if (existing) {
      await query(`
        UPDATE template_performance SET
          total_trades = $2,
          win_rate = $3, avg_return_pct = $4, profit_factor = $5,
          sharpe = $6, max_drawdown = $7
        WHERE template_id = $1
      `, [perf.template_id, perf.total_trades,
          perf.win_rate, perf.avg_pnl_pct || perf.avg_return_pct, perf.profit_factor,
          perf.sharpe_ratio || perf.sharpe || null, perf.max_drawdown_pct || perf.max_drawdown || null]);
    } else {
      await query(`
        INSERT INTO template_performance (
          template_id, period_start, period_end, total_trades,
          win_rate, avg_return_pct, profit_factor, sharpe, max_drawdown
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [perf.template_id, new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10),
          perf.total_trades,
          perf.win_rate, perf.avg_pnl_pct || perf.avg_return_pct, perf.profit_factor,
          perf.sharpe_ratio || perf.sharpe || null, perf.max_drawdown_pct || perf.max_drawdown || null]);
    }
  }

  parseOutput(text) {
    try {
      // Try standard ```json block extraction (allow whitespace variations)
      const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        return { ...parsed, signals: [], overallConfidence: null };
      }
      // Fallback: find outermost { ... } in the text
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
        return { ...parsed, signals: [], overallConfidence: null };
      }
    } catch (err) { console.warn('[PATTERN_DISCOVERY] JSON parse failed in parseOutput:', err.message); }
    console.warn('[PATTERN_DISCOVERY] parseOutput fell back to empty — raw output starts with:', text?.slice(0, 200));
    return { new_templates: [], template_actions: [], anti_patterns: [], signals: [], overallConfidence: null };
  }
}

module.exports = PatternDiscoveryAgent;
