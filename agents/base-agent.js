/**
 * Base Agent — shared logic for all agents.
 * Handles: context building, Claude API calls, signal storage, cost tracking.
 *
 * Supports centralized prompts (config/agent-prompts.js) and context builders
 * (agents/context-builders.js) with fallback to subclass methods.
 */

const Anthropic = require('@anthropic-ai/sdk');
const decisionsDb = require('../db/queries/decisions');
const signalsDb = require('../db/queries/signals');
const costsDb = require('../db/queries/costs');
const learningsDb = require('../db/queries/learnings');
const AGENT_PROMPTS = require('../config/agent-prompts');
const { CONTEXT_BUILDERS } = require('./context-builders');

const client = new Anthropic();

// Model pricing (per 1M tokens)
const PRICING = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
};

// Map agent names to prompt/context keys
const AGENT_NAME_TO_PROMPT_KEY = {
  'trend': 'trendAgent',
  'momentum': 'momentumAgent',
  'volatility': 'volatilityAgent',
  'volume': 'volumeAgent',
  'pattern': 'patternAgent',
  'orderflow': 'orderFlowAgent',
  'macro': 'macroAgent',
  'sentiment': 'sentimentAgent',
  'synthesizer': 'strategySynthesizer',
  'risk_manager': 'riskManager',
  'regime_classifier': 'regimeClassifier',
  'performance_analyst': 'performanceAnalyst',
  'pattern_discovery': 'patternDiscovery',
};

class BaseAgent {
  constructor({ name, layer = 'knowledge', model = 'claude-sonnet-4-6' }) {
    this.name = name;
    this.layer = layer;
    this.model = model;
    this.promptKey = AGENT_NAME_TO_PROMPT_KEY[name] || name;
  }

  /**
   * Run the agent: build context → call Claude → parse signals → store everything.
   */
  async run({ symbols, indicators, marketData, cycleNumber, ...extraContext }) {
    const start = Date.now();

    // Resolve system prompt: centralized → subclass fallback
    const centralizedPrompt = AGENT_PROMPTS[this.promptKey];
    let systemPrompt;
    if (centralizedPrompt) {
      systemPrompt = centralizedPrompt;
    } else {
      systemPrompt = this.buildSystemPrompt();
    }

    // Resolve user prompt: centralized context builder → subclass fallback
    let fullUserPrompt;
    const contextBuilder = CONTEXT_BUILDERS[this.promptKey];
    if (contextBuilder) {
      try {
        const symbolNames = (symbols || []).map(s => typeof s === 'string' ? s : s.symbol);
        const assetClass = (symbols || [])[0]?.asset_class || 'crypto';
        fullUserPrompt = await contextBuilder({
          symbols: symbolNames,
          assetClass,
          cycleNumber,
          indicators,
          // Strategy/analysis agents may pass extra context
          parentDecision: extraContext._parentDecision || extraContext.parentDecision,
          trigger: extraContext._trigger || extraContext.trigger || this.name,
          ...extraContext,
        });
      } catch (ctxErr) {
        console.warn(`[${this.name.toUpperCase()}] Context builder failed, falling back to subclass:`, ctxErr.message);
        const userPrompt = this.buildUserPrompt({ symbols, indicators, marketData });
        const memories = await this.getMemoryInjection(symbols || []);
        fullUserPrompt = memories
          ? `${userPrompt}\n\n## Relevant Learnings from Memory\n${memories}`
          : userPrompt;
      }
    } else {
      // Subclass path with memory injection
      const userPrompt = this.buildUserPrompt({ symbols, indicators, marketData, ...extraContext });
      const memories = await this.getMemoryInjection(symbols || []);
      fullUserPrompt = memories
        ? `${userPrompt}\n\n## Relevant Learnings from Memory\n${memories}`
        : userPrompt;
    }

    let decision;
    let inputTokens = 0, outputTokens = 0, costUsd = 0;
    try {
      // Call Claude with retry on rate limit
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await client.messages.create({
            model: this.model,
            max_tokens: this.promptKey === 'strategySynthesizer' ? 16000 : 8192,
            system: systemPrompt,
            messages: [{ role: 'user', content: fullUserPrompt }],
          });
          break;
        } catch (apiErr) {
          if (apiErr.status === 429 && attempt < 2) {
            const wait = (attempt + 1) * 15000;
            console.log(`[${this.name.toUpperCase()}] Rate limited, waiting ${wait/1000}s...`);
            await new Promise(r => setTimeout(r, wait));
          } else {
            throw apiErr;
          }
        }
      }

      const outputText = response.content[0]?.text || '';
      inputTokens = response.usage?.input_tokens || 0;
      outputTokens = response.usage?.output_tokens || 0;
      costUsd = this.calculateCost(inputTokens, outputTokens);
      const durationMs = Date.now() - start;

      // Parse signals from response
      const parsed = this.parseOutput(outputText, symbols);

      // Store decision
      decision = await decisionsDb.create({
        agent_name: this.name,
        agent_layer: this.layer,
        cycle_number: cycleNumber,
        model_used: this.model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        reasoning: outputText,
        confidence_score: parsed.overallConfidence,
        output_json: parsed,
        duration_ms: durationMs,
        error: null,
      });

      // Store signals — skip any without required fields
      const symbolNames = (symbols || []).map(s => typeof s === 'string' ? s : s.symbol);
      let storedCount = 0;
      for (const signal of parsed.signals || []) {
        // Require symbol — default to first symbol if only one tracked
        const sym = signal.symbol || (symbolNames.length === 1 ? symbolNames[0] : null);
        if (!sym || !signal.signal_type || !signal.direction) {
          console.warn(`[${this.name.toUpperCase()}] Skipping signal missing required fields: symbol=${signal.symbol}, type=${signal.signal_type}`);
          continue;
        }
        try {
          await signalsDb.create({
            agent_name: this.name,
            agent_decision_id: decision.id,
            symbol: sym,
            asset_class: signal.asset_class || 'crypto',
            signal_type: signal.signal_type,
            signal_category: signal.signal_category || this.name,
            direction: signal.direction,
            strength: signal.strength,
            parameters: signal.parameters,
            reasoning: signal.reasoning,
            cycle_number: cycleNumber,
            timeframe: signal.timeframe || '4h',
            ttl_candles: signal.ttl_candles || 6,
            expires_at: signal.expires_at || new Date(Date.now() + 6 * 4 * 3600 * 1000).toISOString(),
            decay_model: ['linear', 'cliff', 'exponential'].includes(signal.decay_model) ? signal.decay_model : 'linear',
          });
          storedCount++;
        } catch (sigErr) {
          console.warn(`[${this.name.toUpperCase()}] Failed to store signal ${signal.signal_type} for ${sym}:`, sigErr.message);
        }
      }

      // Track cost
      await costsDb.record({
        service: 'anthropic',
        agent_name: this.name,
        model: this.model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        cycle_number: cycleNumber,
      });

      console.log(`[${this.name.toUpperCase()}] Completed in ${durationMs}ms — ${storedCount}/${parsed.signals?.length || 0} signals stored, $${costUsd.toFixed(4)}`);

    } catch (err) {
      decision = await decisionsDb.create({
        agent_name: this.name,
        agent_layer: this.layer,
        cycle_number: cycleNumber,
        model_used: this.model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        reasoning: null,
        confidence_score: null,
        output_json: null,
        duration_ms: Date.now() - start,
        error: err.message,
      });
      console.error(`[${this.name.toUpperCase()}] Error:`, err.message);
    }

    return decision;
  }

  /**
   * Override in subclass: define the agent's system prompt.
   * Centralized prompts in config/agent-prompts.js take precedence.
   */
  buildSystemPrompt() {
    return '';
  }

  /**
   * Override in subclass: build the user message with market context.
   * Centralized context builders in agents/context-builders.js take precedence.
   */
  buildUserPrompt({ symbols, indicators, marketData }) {
    return '';
  }

  /**
   * Override in subclass: parse Claude's response into structured signals.
   */
  parseOutput(text, symbols) {
    // Default: try to parse JSON from the response
    try {
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) return JSON.parse(jsonMatch[1]);

      // Try parsing entire response as JSON
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    } catch {
      // JSON may be truncated (hit max_tokens). Try to salvage complete signals.
    }

    // Truncated JSON recovery: extract individual signal objects from the array
    try {
      const signalsStart = text.indexOf('"signals"');
      if (signalsStart === -1) return { signals: [], overallConfidence: null };

      const arrayStart = text.indexOf('[', signalsStart);
      if (arrayStart === -1) return { signals: [], overallConfidence: null };

      // Find each complete {...} object in the signals array
      const signals = [];
      let depth = 0, objStart = -1;
      for (let i = arrayStart + 1; i < text.length; i++) {
        if (text[i] === '{' && depth === 0) { objStart = i; depth = 1; }
        else if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0 && objStart >= 0) {
            try {
              signals.push(JSON.parse(text.substring(objStart, i + 1)));
            } catch { /* skip malformed signal */ }
            objStart = -1;
          }
        }
      }

      if (signals.length > 0) {
        console.log(`[${this.name.toUpperCase()}] Recovered ${signals.length} signals from truncated JSON`);
        return { signals, overallConfidence: null };
      }
    } catch { /* recovery failed */ }

    return { signals: [], overallConfidence: null };
  }

  /**
   * Get relevant learnings for memory injection (subclass fallback path).
   */
  async getMemoryInjection(symbols) {
    try {
      const symbolNames = (symbols || []).map(s => typeof s === 'string' ? s : s.symbol);
      const learnings = await learningsDb.getForContext({
        symbols: symbolNames,
        asset_classes: ['crypto'],
        limit: 10,
      });

      if (!learnings || learnings.length === 0) return null;

      return learnings.map(l =>
        `- [${l.confidence}] ${l.insight_text} (${l.category})`
      ).join('\n');
    } catch {
      return null;
    }
  }

  calculateCost(inputTokens, outputTokens) {
    const pricing = PRICING[this.model] || PRICING['claude-sonnet-4-6'];
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  }
}

module.exports = BaseAgent;
