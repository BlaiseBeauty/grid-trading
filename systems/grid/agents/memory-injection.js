/**
 * Memory Injection — provides getRelevantMemory() for context builders.
 * Queries learnings, temporal patterns, and analogical memory with
 * token budgets per agent tier.
 */

const learningsDb = require('../../../db/queries/learnings');
const { queryAll } = require('../../../db/connection');

const TOKEN_BUDGETS = {
  trendAgent: 500,
  momentumAgent: 500,
  volatilityAgent: 500,
  volumeAgent: 500,
  patternAgent: 500,
  orderFlowAgent: 500,
  macroAgent: 500,
  sentimentAgent: 500,
  strategySynthesizer: 2000,
  riskManager: 800,
  positionReviewer: 800,
  regimeClassifier: 500,
  performanceAnalyst: 0,
  patternDiscovery: 0,
};

/**
 * Get relevant memory for injection into agent context.
 * @param {string} agentName — camelCase agent key
 * @param {object} opts — { symbols, assetClasses, regime, signalCategories }
 * @returns {string|null} — formatted memory text or null
 */
async function getRelevantMemory(agentName, { symbols, assetClasses, regime, signalCategories } = {}) {
  const budget = TOKEN_BUDGETS[agentName] || 500;
  if (budget === 0) return null;

  try {
    const parts = [];

    // 1. Core learnings
    const learnings = await learningsDb.getForContext({
      symbols: symbols || [],
      asset_classes: assetClasses || ['crypto'],
      limit: Math.min(Math.floor(budget / 50), 20),
    });

    if (learnings && learnings.length > 0) {
      parts.push(learnings.map(l =>
        `- [${l.confidence}] ${l.insight_text} (${l.category})`
      ).join('\n'));
    }

    // 2. Temporal patterns (for agents with larger budgets)
    if (budget >= 800) {
      try {
        const temporal = await queryAll(`
          SELECT pattern_type, time_key, win_rate, avg_return_pct, symbol
          FROM temporal_patterns
          WHERE active = true
            AND (symbol = ANY($1) OR symbol IS NULL)
          ORDER BY significance DESC
          LIMIT 5
        `, [symbols || []]);

        if (temporal.length > 0) {
          parts.push('\nTemporal Patterns:');
          parts.push(temporal.map(t =>
            `- ${t.pattern_type}/${t.time_key}${t.symbol ? ` (${t.symbol})` : ''}: ${t.win_rate}% WR, ${t.avg_return_pct}% avg`
          ).join('\n'));
        }
      } catch (err) {
        if (!err.message.includes('does not exist')) {
          console.warn('[MEMORY] Temporal patterns query failed:', err.message);
        }
      }
    }

    // 3. Sequence patterns (synthesizer only)
    if (budget >= 1500) {
      try {
        const sequences = await queryAll(`
          SELECT pattern_description, win_rate, sample_size
          FROM sequence_patterns
          WHERE active = true
          ORDER BY significance DESC
          LIMIT 3
        `);

        if (sequences.length > 0) {
          parts.push('\nSequence Patterns:');
          parts.push(sequences.map(s =>
            `- ${s.pattern_description}: ${s.win_rate}% WR (n=${s.sample_size})`
          ).join('\n'));
        }
      } catch (err) {
        if (!err.message.includes('does not exist')) {
          console.warn('[MEMORY] Sequence patterns query failed:', err.message);
        }
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  } catch (err) {
    console.warn('[MEMORY] Memory injection failed:', err.message);
    return null;
  }
}

module.exports = { getRelevantMemory };
