/**
 * Agent configuration — models, scheduling, and prompt templates.
 * NOTE: nothing in the repo currently requires this file; model ids are centralised in
 * shared/models.js (env-overridable) and this file only re-exports them so it can never drift.
 * The actual model used by each agent class is its constructor argument (see systems/grid/agents/**).
 */

const { MODELS } = require('../../../shared/models');

module.exports = {
  // Layer 1: Knowledge Agents (all Sonnet, run in parallel)
  knowledge: {
    trend:      { model: MODELS.grid_knowledge, schedule: '*/4h', parallel: true },
    momentum:   { model: MODELS.grid_knowledge, schedule: '*/4h', parallel: true },
    volatility: { model: MODELS.grid_knowledge, schedule: '*/4h', parallel: true },
    volume:     { model: MODELS.grid_knowledge, schedule: '*/4h', parallel: true },
    pattern:    { model: MODELS.grid_knowledge, schedule: '*/4h', parallel: true },
    orderflow:  { model: MODELS.grid_knowledge, schedule: '*/4h', parallel: true },
    macro:      { model: MODELS.grid_knowledge, schedule: '*/4h', parallel: true },
    sentiment:  { model: MODELS.grid_knowledge, schedule: '*/4h', parallel: true },
  },

  // Layer 2: Strategy Agents (sequential, after knowledge layer)
  strategy: {
    synthesizer:      { model: MODELS.grid_synthesizer, schedule: 'after_knowledge' },
    risk_manager:     { model: MODELS.grid_strategy, schedule: 'after_synthesizer' },
    regime_classifier: { model: MODELS.grid_strategy, schedule: 'after_knowledge' },
  },

  // Layer 3: Analysis Agents (periodic, not every cycle)
  analysis: {
    performance_analyst: { model: MODELS.grid_analysis, schedule: 'daily' },
    pattern_discovery:   { model: MODELS.grid_analysis, schedule: 'daily' },
  },
};
