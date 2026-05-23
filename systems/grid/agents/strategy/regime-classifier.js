/**
 * Regime Classifier (Sonnet) — Classifies current market regime per asset class.
 * Runs first in the strategy layer to provide context for Synthesizer decisions.
 */

const BaseAgent = require('../base-agent');
const { queryOne, queryAll, query } = require('../../../../db/connection');

const BRAIN_API_URL    = 'https://brain-web-production-41af.up.railway.app';
const BRAIN_API_SECRET = process.env.BRAIN_API_SECRET || null;

/** Map GRID-native regime labels to Brain color codes and numeric scores. */
const REGIME_MAP = {
  trending_up:   { color: 'GREEN', score: 85 },
  trending_down: { color: 'RED',   score: 15 },
  volatile:      { color: 'AMBER', score: 40 },
  ranging:       { color: 'AMBER', score: 55 },
  quiet:         { color: 'AMBER', score: 50 },
};

class RegimeClassifierAgent extends BaseAgent {
  constructor() {
    super({ name: 'regime_classifier', layer: 'strategy', model: 'claude-sonnet-4-6', costTier: 'grid_knowledge' });
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
    const VALID_REGIMES = ['trending_up', 'trending_down', 'volatile', 'ranging', 'quiet'];
    const parsed = result?.output_json || {};
    if (parsed.regime) {
      if (!VALID_REGIMES.includes(parsed.regime)) {
        console.warn(`[REGIME_CLASSIFIER] Invalid regime "${parsed.regime}" — clamping to "ranging"`);
        parsed.regime = 'ranging';
      }
      await this.storeRegime(parsed, result?.id);
      console.log(`[REGIME_CLASSIFIER] Stored regime: ${parsed.regime} conf=${parsed.confidence}`);

      // Best-effort: forward regime signal to Brain external_snapshots
      this.postRegimeToBrain(parsed).catch(err =>
        console.warn('[REGIME_CLASSIFIER] Brain POST skipped (non-fatal):', err.message)
      );
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

  async postRegimeToBrain(parsed) {
    if (!BRAIN_API_SECRET) {
      console.log('[REGIME_CLASSIFIER] BRAIN_API_SECRET not set — skipping Brain POST');
      return;
    }

    const { color, score } = REGIME_MAP[parsed.regime] || { color: 'AMBER', score: 50 };
    const evidenceParts = (parsed.evidence || []).slice(0, 2).map(e => String(e));
    const signal = evidenceParts.length ? evidenceParts.join(' | ') : `Regime: ${parsed.regime}`;

    const payload = {
      regime:     parsed.regime,
      color,
      confidence: parsed.confidence ?? null,
      signal,
      score,
      timestamp:  new Date().toISOString(),
    };

    const res = await fetch(`${BRAIN_API_URL}/api/capture/regime-signal`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${BRAIN_API_SECRET}`,
      },
      body:   JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`Brain API HTTP ${res.status}`);
    console.log(`[REGIME_CLASSIFIER] Brain POST OK — ${parsed.regime} (${color})`);
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
