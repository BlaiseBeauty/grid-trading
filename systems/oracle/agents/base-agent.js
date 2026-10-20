'use strict';

const llm = require('../../../shared/llm-client');
const { MODELS } = require('../../../shared/models');
const { validateThesis, UNTRUSTED_INSTRUCTION } = require('./validation');

// ORACLE thesis output schema — all domain agents must return this structure
const THESIS_SCHEMA = `
{
  "thesis_id": "oracle-thesis-XXX",
  "name": "Short memorable name for this thesis",
  "domain": "macro|geopolitical|technology|commodity|equity|crypto",
  "direction": "bull|bear|neutral",
  "conviction": 7.5,
  "time_horizon": "tactical|strategic|structural",
  "summary": "2-3 sentence explanation of the thesis",
  "long_assets": ["TICKER1", "TICKER2"],
  "short_assets": ["TICKER3"],
  "watch_assets": ["TICKER4"],
  "catalyst": "What specific event would confirm this thesis",
  "invalidation": "What specific event would kill this thesis",
  "competing_view": "The strongest counter-argument",
  "evidence_summary": "1-2 sentences summarising the evidence supporting this"
}
`;

class OracleBaseAgent {
  constructor(opts = {}) {
    this.name       = opts.name || 'oracle-base';
    this.domain     = opts.domain || 'macro';
    this.model      = opts.model || MODELS.oracle_domain;
    this.costTier   = opts.costTier || 'oracle_domain';
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
      source: 'oracle',
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
      source: 'oracle', agentName: this.name, layer: 'knowledge', model: result.model,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd,
      text: result.text, cycleId,
    });

    return result.text;
  }

  /** Append the untrusted-data handling rule to a system prompt (use for any agent fed external text). */
  withInjectionGuard(systemPrompt) {
    return `${systemPrompt}\n\n${UNTRUSTED_INSTRUCTION}`;
  }

  /** Generic JSON-object parse (fence stripping, outermost-object slice). Returns object or null. */
  parseJsonObject(rawContent) {
    const res = llm.extractJson(rawContent);
    if (!res.ok) {
      console.error(`[${this.name}] JSON parse failed: ${res.error}`);
      return null;
    }
    return res.value;
  }

  /**
   * Parse + validate a Claude response into a Thesis Object (enums, conviction 0..10, asset arrays).
   * Returns the validated thesis or null (reason logged).
   */
  parseThesis(rawContent) {
    const obj = this.parseJsonObject(rawContent);
    if (!obj) return null;
    const v = validateThesis(obj, { expectedDomain: this.domain });
    if (!v.ok) {
      console.error(`[${this.name}] Thesis rejected: ${v.error}`);
      return null;
    }
    return v.thesis;
  }

  getThesisSchema() { return THESIS_SCHEMA; }
}

module.exports = OracleBaseAgent;
