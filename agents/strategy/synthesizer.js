/**
 * Strategy Synthesizer (Opus) — The brain of GRID.
 * Receives all knowledge agent signals, matches against templates,
 * scores combinations, and produces trade proposals for Risk Manager.
 */

const BaseAgent = require('../base-agent');
const signalsDb = require('../../db/queries/signals');
const templatesDb = require('../../db/queries/templates');
const { queryAll } = require('../../db/connection');

class SynthesizerAgent extends BaseAgent {
  constructor() {
    super({ name: 'synthesizer', layer: 'strategy', model: 'claude-sonnet-4-6' });
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
    try {
      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          ...parsed,
          signals: [], // Synthesizer doesn't emit signals — it emits proposals
          overallConfidence: parsed.proposals?.[0]?.confidence || null,
        };
      }
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) return { ...JSON.parse(trimmed), signals: [] };
    } catch {}
    return { proposals: [], rejections: [], signals: [], overallConfidence: null };
  }
}

module.exports = SynthesizerAgent;
