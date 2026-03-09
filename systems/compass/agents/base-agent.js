'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const aiCosts   = require('../../../shared/ai-costs');
const { query } = require('../../../db/connection');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

class CompassBaseAgent {
  constructor(opts = {}) {
    this.name       = opts.name     || 'compass-base';
    this.model      = opts.model    || 'claude-opus-4-5';
    this.costTier   = opts.costTier || 'compass_portfolio';
    this.maxRetries = 3;
  }

  async callClaude(systemPrompt, userPrompt, opts = {}) {
    const budget    = aiCosts.getBudget(this.costTier);
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

        const usage = response.usage;

        // Record cost
        aiCosts.recordUsage({
          source_system: 'compass',
          agent_name:    this.name,
          model:         response.model,
          input_tokens:  usage.input_tokens,
          output_tokens: usage.output_tokens,
        }).catch(() => {});

        // Store decision (adapted for actual agent_decisions schema)
        try {
          await query(
            `INSERT INTO agent_decisions
               (agent_name, agent_layer, model_used, input_tokens, output_tokens,
                cost_usd, output_json, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
            [
              this.name, 'strategy',
              response.model,
              usage.input_tokens, usage.output_tokens,
              aiCosts.calculateCost(response.model, usage.input_tokens, usage.output_tokens),
              JSON.stringify({ raw_output: response.content[0]?.text?.slice(0, 2000) || '' }),
            ]
          );
        } catch { /* non-critical */ }

        return response.content[0]?.text || '';

      } catch (err) {
        lastError = err;
        if (err.status === 429) {
          const wait = attempt === 1 ? 15000 : attempt === 2 ? 30000 : 60000;
          console.warn(`[${this.name}] Rate limit, waiting ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          throw err;
        }
      }
    }
    throw lastError;
  }

  parseJSON(raw) {
    try {
      const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const start = clean.indexOf('{');
      const end   = clean.lastIndexOf('}');
      if (start === -1) throw new Error('No JSON found');
      return JSON.parse(clean.slice(start, end + 1));
    } catch (err) {
      console.error(`[${this.name}] JSON parse failed:`, err.message);
      return null;
    }
  }
}

module.exports = CompassBaseAgent;
