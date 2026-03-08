/**
 * Agent configuration — models, scheduling, and prompt templates.
 * Phase 2 fills in the actual prompt templates.
 */

module.exports = {
  // Layer 1: Knowledge Agents (all Sonnet, run in parallel)
  knowledge: {
    trend:      { model: 'claude-sonnet-4-6', schedule: '*/4h', parallel: true },
    momentum:   { model: 'claude-sonnet-4-6', schedule: '*/4h', parallel: true },
    volatility: { model: 'claude-sonnet-4-6', schedule: '*/4h', parallel: true },
    volume:     { model: 'claude-sonnet-4-6', schedule: '*/4h', parallel: true },
    pattern:    { model: 'claude-sonnet-4-6', schedule: '*/4h', parallel: true },
    orderflow:  { model: 'claude-sonnet-4-6', schedule: '*/4h', parallel: true },
    macro:      { model: 'claude-sonnet-4-6', schedule: '*/4h', parallel: true },
    sentiment:  { model: 'claude-sonnet-4-6', schedule: '*/4h', parallel: true },
  },

  // Layer 2: Strategy Agents (sequential, after knowledge layer)
  strategy: {
    synthesizer:      { model: 'claude-opus-4-6', schedule: 'after_knowledge' },
    risk_manager:     { model: 'claude-sonnet-4-6', schedule: 'after_synthesizer' },
    regime_classifier: { model: 'claude-sonnet-4-6', schedule: 'after_knowledge' },
  },

  // Layer 3: Analysis Agents (periodic, not every cycle)
  analysis: {
    performance_analyst: { model: 'claude-opus-4-6', schedule: 'daily' },
    pattern_discovery:   { model: 'claude-opus-4-6', schedule: 'daily' },
  },
};
