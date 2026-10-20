/**
 * Base Agent — shared logic for all agents.
 * Handles: context building, Claude API calls (via shared/llm-client), signal storage.
 * Cost recording happens exactly once, inside shared/llm-client -> aiCosts.recordUsage.
 *
 * Supports centralized prompts (config/agent-prompts.js) and context builders
 * (agents/context-builders.js) with fallback to subclass methods.
 */

const decisionsDb = require('../../../db/queries/decisions');
const signalsDb = require('../../../db/queries/signals');
const learningsDb = require('../../../db/queries/learnings');
const AGENT_PROMPTS = require('../config/agent-prompts');
const { CONTEXT_BUILDERS } = require('./context-builders');
const logger = require('../../../services/logger');
const aiCosts = require('../../../shared/ai-costs');
const llm = require('../../../shared/llm-client');
const { MODELS } = require('../../../shared/models');

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
  'position_reviewer': 'positionReviewer',
  'regime_classifier': 'regimeClassifier',
  'performance_analyst': 'performanceAnalyst',
  'pattern_discovery': 'patternDiscovery',
};

class BaseAgent {
  constructor({ name, layer = 'knowledge', model = MODELS.grid_knowledge, costTier = 'grid_knowledge' }) {
    this.name = name;
    this.layer = layer;
    this.model = model;
    this.costTier = costTier;
    this.promptKey = AGENT_NAME_TO_PROMPT_KEY[name] || name;
  }

  /** Log prefix carrying the cycle correlation id, e.g. "[TREND c142]". */
  _tag(cycleNumber) {
    return `[${this.name.toUpperCase()}${cycleNumber != null ? ` c${cycleNumber}` : ''}]`;
  }

  /**
   * Run the agent: build context → call Claude → parse signals → store everything.
   */
  async run({ symbols, indicators, marketData, cycleNumber, ...extraContext }) {
    const start = Date.now();
    const tag = this._tag(cycleNumber);

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
        logger.warn(`${tag} Context builder failed, falling back to subclass`, { err: ctxErr, cycle_id: cycleNumber, agent_name: this.name, error_type: 'context_builder' });
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
      // Phase-aware token budgets — reduce output during INFANT/LEARNING to cut costs
      const bootstrapPhase = extraContext?.bootstrapPhase || 'infant';
      const isEarlyPhase = bootstrapPhase === 'infant' || bootstrapPhase === 'learning';
      let rawMaxTokens;
      if (this.promptKey === 'strategySynthesizer') {
        rawMaxTokens = 4096; // Opus synthesis — fixed budget always (was 32000)
      } else if (this.layer === 'knowledge') {
        rawMaxTokens = isEarlyPhase ? 1024 : 2048; // phase-gated for Layer 1 agents
      } else {
        rawMaxTokens = 8192; // strategy/analysis agents — clamped to tier max_output
      }
      const maxTokens = aiCosts.clampMaxTokens(this.costTier, rawMaxTokens);
      const retryOnTruncate = this.promptKey === 'strategySynthesizer' || this.promptKey === 'riskManager';

      // Budget gate (daily $), input-token budget, retry w/ jitter, timeout and cost recording
      // all happen inside llm.callClaude. Throws BudgetExceededError / API errors.
      const result = await llm.callClaude({
        source: 'grid',
        agentName: this.name,
        cycleId: Number.isInteger(cycleNumber) ? cycleNumber : null,
        model: this.model,
        costTier: this.costTier,
        system: systemPrompt,
        user: fullUserPrompt,
        maxTokens,
        retryOnTruncate,
        compressOnTruncate: retryOnTruncate ? (p) => this._compressSignals(p, tag) : undefined,
      });

      const outputText = result.text;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      costUsd = result.costUsd;
      const durationMs = Date.now() - start;

      // Parse signals from response
      const parsed = this.parseOutput(outputText, symbols);

      // Total parse failure must look like a FAILED agent, not a quiet market with zero signals.
      // Raw text is still stored (reasoning) for diagnosis.
      if (parsed && parsed.parse_error) {
        const errMsg = `parse_failed: ${parsed.parse_error}`;
        logger.error(`${tag} Output could not be parsed — marking agent failed`, { cycle_id: cycleNumber, agent_name: this.name, error_type: 'parse_failed', output_chars: outputText.length });
        decision = await decisionsDb.create({
          agent_name: this.name,
          agent_layer: this.layer,
          cycle_number: cycleNumber,
          model_used: this.model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: costUsd,
          reasoning: outputText,
          confidence_score: null,
          output_json: parsed,
          duration_ms: durationMs,
          error: errMsg,
        });
        return decision;
      }

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
          console.warn(`${tag} Skipping signal missing required fields: symbol=${signal.symbol}, type=${signal.signal_type}`);
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
            ttl_candles: Math.max(1, parseInt(signal.ttl_candles) || 6),
            expires_at: (() => {
              const ttl = Math.max(1, parseInt(signal.ttl_candles) || 6);
              const fromSignal = signal.expires_at ? new Date(signal.expires_at) : null;
              const minExpiry = new Date(Date.now() + 15 * 60 * 1000); // must expire at least 15min from now
              const defaultExpiry = new Date(Date.now() + ttl * 4 * 3600 * 1000);
              return (fromSignal && fromSignal > minExpiry) ? fromSignal.toISOString() : defaultExpiry.toISOString();
            })(),
            decay_model: ['linear', 'cliff', 'exponential'].includes(signal.decay_model) ? signal.decay_model : 'linear',
          });
          storedCount++;
        } catch (sigErr) {
          console.warn(`${tag} Failed to store signal ${signal.signal_type} for ${sym}:`, sigErr.message);
        }
      }

      console.log(`${tag} Completed in ${durationMs}ms — ${storedCount}/${parsed.signals?.length || 0} signals stored, $${costUsd.toFixed(4)}`);

    } catch (err) {
      const isBudget = err instanceof aiCosts.BudgetExceededError || err instanceof aiCosts.InputBudgetExceededError;
      try {
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
          error: isBudget ? `${err.code}: ${err.message}` : err.message,
        });
      } catch (dbErr) {
        console.error(`${tag} Failed to store decision:`, dbErr.message, dbErr.stack);
      }
      if (isBudget) console.warn(`${tag} Skipped — ${err.message}`);
      else console.error(`${tag} Error:`, err.message);
    }

    return decision;
  }

  /**
   * Compress a synthesizer/risk prompt for the truncation retry: keep the top 5 active
   * signals by strength. Returns the original prompt if the pattern is not found.
   */
  _compressSignals(prompt, tag = '') {
    try {
      const signalsMatch = prompt.match(/"active_signals"\s*:\s*\[[\s\S]*?\]/);
      if (!signalsMatch) return prompt;
      const signalsArr = JSON.parse(signalsMatch[0].replace('"active_signals":', '').trim());
      const top5 = signalsArr
        .sort((a, b) => (b.decayed_strength || b.strength || 0) - (a.decayed_strength || a.strength || 0))
        .slice(0, 5);
      console.log(`${tag} Compressed signals from ${signalsArr.length} to ${top5.length} for retry`);
      return prompt.replace(signalsMatch[0], `"active_signals":${JSON.stringify(top5)}`);
    } catch (err) {
      logger.debug('Signal compression failed, using full prompt', { err, agent_name: this.name, error_type: 'compress' });
      return prompt;
    }
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
   * Parse Claude's response into structured output. Override in subclass for custom shapes.
   * On TOTAL failure returns { signals: [], overallConfidence: null, parse_error } — run()
   * treats parse_error as a failed agent instead of an empty (quiet-market) signal set.
   */
  parseOutput(text, symbols) {
    const res = llm.extractJson(text, { arrayKeys: ['signals', 'actions'] });
    if (res.ok && !res.recovered) return res.value;

    if (res.ok && res.recovered) {
      const arrayKey = res.value.signals ? 'signals' : 'actions';
      console.log(`[${this.name.toUpperCase()}] Recovered ${res.value[arrayKey].length} ${arrayKey} from truncated JSON`);
      const result = { overallConfidence: null };
      result[arrayKey] = res.value[arrayKey];
      if (arrayKey !== 'signals') result.signals = [];
      return result;
    }

    logger.error('JSON parse and truncation recovery both failed', { agent_name: this.name, error_type: 'json_parse', err: res.error });
    return { signals: [], overallConfidence: null, parse_error: res.error || 'unparseable output' };
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
    } catch (err) {
      logger.warn('Memory injection failed', { err, agent_name: this.name, error_type: 'memory_injection' });
      return null;
    }
  }

  calculateCost(inputTokens, outputTokens) {
    return aiCosts.calculateCost(this.model, inputTokens, outputTokens);
  }
}

module.exports = BaseAgent;
