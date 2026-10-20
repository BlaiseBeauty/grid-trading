'use strict';

const llm = require('../../../shared/llm-client');
const { MODELS } = require('../../../shared/models');

class CompassBaseAgent {
  constructor(opts = {}) {
    this.name       = opts.name     || 'compass-base';
    this.model      = opts.model    || MODELS.compass_portfolio;
    this.costTier   = opts.costTier || 'compass_portfolio';
    this.cycleId    = Number.isInteger(opts.cycleId) ? opts.cycleId : null;
    this.maxRetries = llm.MAX_ATTEMPTS; // retry policy lives in shared/llm-client
  }

  /**
   * Call Claude (budget gates, retry w/ jitter, timeout and cost recording via shared/llm-client).
   * Returns the raw response text. Throws BudgetExceededError / API errors.
   */
  async callClaude(systemPrompt, userPrompt, opts = {}) {
    const cycleId = Number.isInteger(opts.cycleId) ? opts.cycleId : this.cycleId;
    const result = await llm.callClaude({
      source: 'compass',
      agentName: this.name,
      cycleId,
      model: this.model,
      costTier: this.costTier,
      system: systemPrompt,
      user: userPrompt,
      maxTokens: opts.maxTokens,
    });

    // Tag the decision log with source_system so GRID analytics can exclude it
    await llm.logForeignDecision({
      source: 'compass', agentName: this.name, layer: 'strategy', model: result.model,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd,
      text: result.text, cycleId,
    });

    return result.text;
  }

  /**
   * Parse a JSON object from LLM text (fence stripping; unterminated / truncated output returns null,
   * never throws on a missing closing brace). Schema validation lives in ./validation.js.
   */
  parseJSON(raw) {
    const res = llm.extractJson(raw);
    if (!res.ok) {
      console.error(`[${this.name}] JSON parse failed: ${res.error}`);
      return null;
    }
    return res.value;
  }
}

module.exports = CompassBaseAgent;
