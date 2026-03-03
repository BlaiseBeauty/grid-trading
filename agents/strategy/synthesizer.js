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
    // Try clean JSON parse first
    try {
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          ...parsed,
          signals: [], // Synthesizer doesn't emit signals — it emits proposals
          overallConfidence: parsed.proposals?.[0]?.confidence || parsed.actions?.[0]?.confidence || null,
        };
      }
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) return { ...JSON.parse(trimmed), signals: [] };
    } catch (err) {
      console.warn('[SYNTHESIZER] Clean JSON parse failed, attempting truncation recovery');
    }

    // Truncated JSON recovery — search for all possible array keys
    const RECOVERY_KEYS = ['actions', 'proposals', 'trades', 'standing_orders'];
    const recovered = { signals: [], overallConfidence: null };
    let totalRecovered = 0;

    for (const key of RECOVERY_KEYS) {
      const keyIdx = text.indexOf(`"${key}"`);
      if (keyIdx === -1) continue;

      const arrayStart = text.indexOf('[', keyIdx);
      if (arrayStart === -1) continue;

      const objects = [];
      let depth = 0, objStart = -1;
      for (let i = arrayStart + 1; i < text.length; i++) {
        if (text[i] === '{' && depth === 0) { objStart = i; depth = 1; }
        else if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0 && objStart >= 0) {
            try {
              objects.push(JSON.parse(text.substring(objStart, i + 1)));
            } catch { /* skip malformed object */ }
            objStart = -1;
          }
        }
      }

      if (objects.length > 0) {
        recovered[key] = objects;
        totalRecovered += objects.length;
        console.log(`[SYNTHESIZER] Recovered ${objects.length} "${key}" from truncated JSON`);
      }
    }

    if (totalRecovered > 0) {
      return recovered;
    }

    // Zero recovery from a long response = probable truncation loss
    if (text.length > 20000) {
      console.error(`[SYNTHESIZER] CRITICAL: Probable truncation — response length ${text.length} chars, zero actions extracted. Cycle proposals lost.`);
    }

    return { proposals: [], rejections: [], actions: [], standing_orders: [], signals: [], overallConfidence: null };
  }
}

module.exports = SynthesizerAgent;
