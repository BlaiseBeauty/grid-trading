/**
 * Strategy Synthesizer (Opus) — The brain of GRID.
 * Receives all knowledge agent signals, matches against templates,
 * scores combinations, and produces trade proposals for Risk Manager.
 */

const BaseAgent = require('../base-agent');
const signalsDb = require('../../../../db/queries/signals');
const templatesDb = require('../../../../db/queries/templates');
const { queryAll } = require('../../../../db/connection');
const llm = require('../../../../shared/llm-client');
const { MODELS } = require('../../../../shared/models');

// Arrays the synthesizer may emit; used for truncation recovery.
const RECOVERY_KEYS = ['actions', 'proposals', 'trades', 'standing_orders'];

class SynthesizerAgent extends BaseAgent {
  constructor() {
    super({ name: 'synthesizer', layer: 'strategy', model: MODELS.grid_synthesizer, costTier: 'grid_synthesizer' });
  }

  /**
   * Override run — Synthesizer needs signals + templates + regime as input.
   */
  async run({ cycleNumber, regime, broadcast, hoursSinceLastTrade, forcedExploration }) {
    // Gather active signals grouped by symbol
    const allSignals = await this.gatherSignals();
    const activeTemplates = await templatesDb.getActive();
    const antiPatterns = await this.getAntiPatterns();
    const currentRegime = regime || await this.getCurrentRegime();

    return super.run({
      symbols: Object.keys(allSignals),
      indicators: {},
      marketData: {},
      cycleNumber,
      // Pass extra context via a custom property
      _synthContext: { allSignals, activeTemplates, antiPatterns, currentRegime },
      // Exploration context for paper mode
      hoursSinceLastTrade: hoursSinceLastTrade ?? null,
      forcedExploration: forcedExploration || false,
    });
  }

  /**
   * Gather all active (non-expired) signals grouped by symbol.
   */
  async gatherSignals() {
    const signals = await queryAll(`
      SELECT *,
        CASE decay_model
          WHEN 'linear' THEN strength * GREATEST(0, 1.0 -
            EXTRACT(EPOCH FROM (NOW() - created_at)) /
            NULLIF(EXTRACT(EPOCH FROM (expires_at - created_at)), 0))
          WHEN 'exponential' THEN strength * EXP(
            -3.0 * EXTRACT(EPOCH FROM (NOW() - created_at)) /
            NULLIF(EXTRACT(EPOCH FROM (expires_at - created_at)), 0))
          WHEN 'cliff' THEN
            CASE WHEN EXTRACT(EPOCH FROM (NOW() - created_at)) <
                      EXTRACT(EPOCH FROM (expires_at - created_at)) * 0.9
              THEN strength
              ELSE strength * 0.1
            END
          ELSE strength
        END as current_strength
      FROM signals
      WHERE expires_at > NOW()
      ORDER BY symbol, current_strength DESC
    `);

    const grouped = {};
    for (const s of signals) {
      if (!grouped[s.symbol]) grouped[s.symbol] = [];
      grouped[s.symbol].push(s);
    }
    return grouped;
  }

  async getAntiPatterns() {
    return queryAll("SELECT * FROM anti_patterns WHERE active = true");
  }

  async getCurrentRegime() {
    const regimes = await queryAll(`
      SELECT DISTINCT ON (asset_class) *
      FROM market_regime ORDER BY asset_class, created_at DESC
    `);
    return regimes.reduce((acc, r) => { acc[r.asset_class] = r; return acc; }, {});
  }

  parseOutput(text) {
    const res = llm.extractJson(text, { arrayKeys: RECOVERY_KEYS });

    // Clean parse
    if (res.ok && !res.recovered) {
      const parsed = res.value;
      return {
        ...parsed,
        signals: [], // Synthesizer doesn't emit signals — it emits proposals
        overallConfidence: parsed.proposals?.[0]?.confidence || parsed.actions?.[0]?.confidence || null,
      };
    }

    // Truncated JSON recovery — whichever arrays we could salvage
    if (res.ok && res.recovered) {
      const recovered = { signals: [], overallConfidence: null };
      for (const key of RECOVERY_KEYS) {
        if (res.value[key]) {
          recovered[key] = res.value[key];
          console.log(`[SYNTHESIZER] Recovered ${res.value[key].length} "${key}" from truncated JSON`);
        }
      }
      return recovered;
    }

    // Zero recovery: explicit failure (run() marks the decision failed) — never a silent empty set.
    if (String(text || '').length > 20000) {
      console.error(`[SYNTHESIZER] CRITICAL: Probable truncation — response length ${text.length} chars, zero actions extracted. Cycle proposals lost.`);
    }
    return {
      proposals: [], rejections: [], actions: [], standing_orders: [], signals: [],
      overallConfidence: null,
      parse_error: res.error || 'unparseable synthesizer output',
    };
  }
}

module.exports = SynthesizerAgent;
