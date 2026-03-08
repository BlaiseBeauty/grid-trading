'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const aiCosts   = require('../../../shared/ai-costs');
const { query } = require('../../../db/connection');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    this.model      = opts.model || 'claude-sonnet-4-5';
    this.costTier   = opts.costTier || 'oracle_domain';
    this.maxRetries = 3;
  }

  /**
   * Call Claude with a thesis generation prompt.
   * Returns parsed thesis object or null on failure.
   */
  async callClaude(systemPrompt, userPrompt, opts = {}) {
    const budget   = aiCosts.getBudget(this.costTier);
    const maxTokens = opts.maxTokens
      ? Math.min(opts.maxTokens, budget.max_output)
      : budget.max_output;

    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await client.messages.create({
          model:      this.model,
          max_tokens: maxTokens,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: userPrompt }],
        });

        // Record cost
        const usage = response.usage;
        aiCosts.recordUsage({
          source_system: 'oracle',
          agent_name:    this.name,
          model:         response.model,
          input_tokens:  usage.input_tokens,
          output_tokens: usage.output_tokens,
        }).catch(() => {});

        const content = response.content[0]?.text || '';

        // Store agent decision (adapt to actual agent_decisions schema)
        try {
          await query(
            `INSERT INTO agent_decisions
               (agent_name, agent_layer, model_used, input_tokens, output_tokens,
                cost_usd, output_json, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
            [
              this.name, 'knowledge', response.model,
              usage.input_tokens, usage.output_tokens,
              aiCosts.calculateCost(response.model, usage.input_tokens, usage.output_tokens),
              JSON.stringify({ raw_output: content.slice(0, 2000) }),
            ]
          );
        } catch { /* non-critical */ }

        return content;

      } catch (err) {
        lastError = err;
        if (err.status === 429) {
          const wait = attempt === 1 ? 15000 : attempt === 2 ? 30000 : 60000;
          console.warn(`[${this.name}] Rate limit, waiting ${wait}ms (attempt ${attempt})`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          console.error(`[${this.name}] API error:`, err.message);
          throw err;
        }
      }
    }
    throw lastError;
  }

  /**
   * Parse a Claude response into a Thesis Object.
   * Handles markdown code blocks and raw JSON.
   */
  parseThesis(rawContent) {
    try {
      // Strip markdown code fences if present
      const clean = rawContent
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      // Find JSON object
      const start = clean.indexOf('{');
      const end   = clean.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON object found');

      const thesis = JSON.parse(clean.slice(start, end + 1));

      // Validate required fields
      const required = ['name', 'domain', 'direction', 'conviction', 'time_horizon', 'summary'];
      for (const field of required) {
        if (!thesis[field]) throw new Error(`Missing required field: ${field}`);
      }

      // Normalise
      thesis.conviction   = Math.max(0, Math.min(10, parseFloat(thesis.conviction)));
      thesis.long_assets  = thesis.long_assets  || [];
      thesis.short_assets = thesis.short_assets || [];
      thesis.watch_assets = thesis.watch_assets || [];

      return thesis;
    } catch (err) {
      console.error(`[${this.name}] Thesis parse failed:`, err.message);
      return null;
    }
  }

  getThesisSchema() { return THESIS_SCHEMA; }
}

module.exports = OracleBaseAgent;
