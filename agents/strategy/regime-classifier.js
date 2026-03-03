/**
 * Regime Classifier (Sonnet) — Classifies current market regime per asset class.
 * Runs first in the strategy layer to provide context for Synthesizer decisions.
 */

const BaseAgent = require('../base-agent');
const { queryOne, queryAll, query } = require('../../db/connection');

class RegimeClassifierAgent extends BaseAgent {
  constructor() {
    super({ name: 'regime_classifier', layer: 'strategy', model: 'claude-sonnet-4-6' });
  }

  /**
   * Override run — needs multi-timeframe indicators and recent regime history.
   */
  async run({ cycleNumber, indicators, broadcast }) {
    const recentRegimes = await this.getRecentRegimes();
    const volatilityContext = await this.getVolatilityContext();

    const result = await super.run({
      symbols: Object.keys(indicators || {}),
      indicators: indicators || {},
      marketData: {},
      cycleNumber,
      _regimeContext: { recentRegimes, volatilityContext },
    });

    // Store regime classification
    const parsed = result?.output_json || {};
    if (parsed.regime) {
      await this.storeRegime(parsed, result?.id);
      console.log(`[REGIME_CLASSIFIER] Stored regime: ${parsed.regime} conf=${parsed.confidence}`);
    }

    return result;
  }

  async getRecentRegimes() {
    return queryAll(`
      SELECT * FROM market_regime
      ORDER BY created_at DESC
      LIMIT 20
    `);
  }

  async getVolatilityContext() {
    return queryAll(`
      SELECT symbol, timeframe,
        AVG(high - low) as avg_range,
        STDDEV(close) as price_stddev,
        COUNT(*) as candle_count
      FROM market_data
      WHERE timestamp > NOW() - INTERVAL '7 days'
      GROUP BY symbol, timeframe
      ORDER BY symbol, timeframe
    `);
  }

  async storeRegime(output, agentDecisionId) {
    const r = output;
    const probs = r.transition_probabilities || {};
    const highest_transition = Object.keys(probs).length
      ? Object.keys(probs).reduce((a, b) => probs[a] > probs[b] ? a : b)
      : null;

    await query(`
      INSERT INTO market_regime (
        asset_class, regime, confidence, evidence, agent_decision_id,
        recommended_cycle_interval, transition_probabilities,
        transition_signals, highest_transition
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      'crypto',
      r.regime,
      r.confidence,
      JSON.stringify(r.evidence || []),
      agentDecisionId || null,
      r.recommended_adjustments?.cycle_interval || '4h',
      JSON.stringify(r.transition_probabilities || {}),
      JSON.stringify(r.recommended_adjustments || {}),
      highest_transition
    ]);
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
    } catch (err) { console.warn('[REGIME_CLASSIFIER] JSON parse failed in parseOutput:', err.message); }
    return { regimes: [], signals: [], overallConfidence: null };
  }
}

module.exports = RegimeClassifierAgent;
