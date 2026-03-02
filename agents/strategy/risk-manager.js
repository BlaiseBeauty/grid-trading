/**
 * Risk Manager (Sonnet) — Validates trade proposals against hard limits.
 * Code enforces, AI recommends. This agent is the last gate before execution.
 */

const BaseAgent = require('../base-agent');
const riskLimits = require('../../config/risk-limits');
const { queryOne, queryAll, query } = require('../../db/connection');

class RiskManagerAgent extends BaseAgent {
  constructor() {
    super({ name: 'risk_manager', layer: 'strategy', model: 'claude-sonnet-4-6' });
  }

  /**
   * Override run — takes Synthesizer proposals as input.
   */
  async run({ cycleNumber, proposals, broadcast }) {
    // Get current system state for limit checking
    const systemState = await this.getSystemState();

    // Code-enforced pre-flight — reject anything that violates hard limits
    const { passed, codeRejected } = this.preflightCheck(proposals, systemState);

    // Store code-rejected opportunities
    for (const rej of codeRejected) {
      await this.storeRejection(cycleNumber, rej);
    }

    if (passed.length === 0) {
      console.log('[RISK_MANAGER] All proposals rejected by code-enforced limits');
      return { approved: [], rejected: codeRejected, decision: null };
    }

    // For surviving proposals, ask Claude for nuanced risk assessment
    const result = await super.run({
      symbols: passed.map(p => p.symbol),
      indicators: {},
      marketData: {},
      cycleNumber,
      _riskContext: { proposals: passed, systemState, codeRejected },
    });

    // Parse Claude's risk assessment
    const assessment = result?.output_json || { approved: [], rejected: [] };

    // Store Claude-rejected opportunities
    for (const rej of (assessment.rejected || [])) {
      await this.storeRejection(cycleNumber, {
        symbol: rej.symbol,
        direction: rej.direction,
        confidence: rej.confidence,
        rejection_reason: rej.reason || 'risk_manager_rejected',
        rejection_detail: rej.detail,
      });
    }

    return {
      approved: assessment.approved || [],
      rejected: [...codeRejected, ...(assessment.rejected || [])],
      decision: result,
    };
  }

  /**
   * Hard-coded pre-flight check. Code enforces — AI cannot override these.
   */
  preflightCheck(proposals, state) {
    const passed = [];
    const codeRejected = [];
    const limits = this.getEffectiveLimits(state);

    for (const proposal of proposals || []) {
      const reasons = [];

      // Max open positions
      if (state.openPositions >= limits.MAX_OPEN_POSITIONS) {
        reasons.push(`max_positions_reached (${state.openPositions}/${limits.MAX_OPEN_POSITIONS})`);
      }

      // Daily loss limit
      if (state.dailyLossPct >= limits.MAX_DAILY_LOSS_PCT) {
        reasons.push(`daily_loss_limit (${state.dailyLossPct.toFixed(1)}% >= ${limits.MAX_DAILY_LOSS_PCT}%)`);
      }

      // Min confidence
      if (proposal.confidence < limits.MIN_CONFIDENCE_TO_TRADE) {
        reasons.push(`low_confidence (${proposal.confidence} < ${limits.MIN_CONFIDENCE_TO_TRADE})`);
      }

      // Min complexity score
      if ((proposal.complexity_score || 0) < riskLimits.MIN_SIGNAL_COMPLEXITY) {
        reasons.push(`low_complexity (${proposal.complexity_score || 0} < ${riskLimits.MIN_SIGNAL_COMPLEXITY})`);
      }

      // Position size limit
      if ((proposal.position_size_suggestion_pct || 0) > limits.MAX_SINGLE_POSITION_PCT) {
        proposal.position_size_suggestion_pct = limits.MAX_SINGLE_POSITION_PCT;
      }

      // SCRAM check
      if (state.scramLevel === 'crisis' || state.scramLevel === 'emergency') {
        reasons.push(`scram_active (${state.scramLevel})`);
      }

      // Bootstrap paper-only check
      if (limits.PAPER_ONLY && proposal.mode === 'live') {
        reasons.push('bootstrap_paper_only');
      }

      if (reasons.length > 0) {
        codeRejected.push({
          symbol: proposal.symbol,
          direction: proposal.direction,
          confidence: proposal.confidence,
          rejection_reason: 'code_enforced',
          rejection_detail: reasons.join('; '),
          signals_present: proposal.supporting_signals,
        });
      } else {
        passed.push(proposal);
      }
    }

    return { passed, codeRejected };
  }

  /**
   * Get effective limits based on bootstrap phase and SCRAM level.
   */
  getEffectiveLimits(state) {
    let limits = { ...riskLimits };

    // Apply bootstrap overrides
    const bootstrapOverride = riskLimits.BOOTSTRAP[state.bootstrapPhase];
    if (bootstrapOverride) {
      limits = { ...limits, ...bootstrapOverride };
    }

    // Apply SCRAM overrides (strictest wins)
    if (state.scramLevel) {
      const scramOverride = riskLimits.SCRAM[state.scramLevel];
      if (scramOverride) {
        limits = { ...limits, ...scramOverride };
      }
    }

    return limits;
  }

  /**
   * Get current system state for limit checking.
   */
  async getSystemState() {
    const [openTrades, bootstrap, scram, dailyPnl, portfolio] = await Promise.all([
      queryAll("SELECT * FROM trades WHERE status = 'open'"),
      queryOne('SELECT * FROM bootstrap_status ORDER BY id DESC LIMIT 1'),
      queryOne("SELECT * FROM scram_events WHERE cleared_at IS NULL ORDER BY activated_at DESC LIMIT 1"),
      queryOne(`
        SELECT COALESCE(SUM(pnl_realised), 0) as daily_pnl
        FROM trades
        WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '24 hours'
      `),
      queryOne('SELECT COALESCE(SUM(quantity * current_price), 0) as total_value FROM portfolio_state'),
    ]);

    const totalValue = parseFloat(portfolio?.total_value) || 10000; // Default $10k for new system
    const dailyPnlPct = totalValue > 0 ? (parseFloat(dailyPnl?.daily_pnl) / totalValue) * 100 : 0;

    return {
      openPositions: openTrades.length,
      openTrades,
      bootstrapPhase: bootstrap?.phase || 'infant',
      scramLevel: scram?.level || null,
      dailyLossPct: Math.abs(Math.min(0, dailyPnlPct)),
      totalPortfolioValue: totalValue,
    };
  }

  async storeRejection(cycleNumber, rej) {
    try {
      await query(`
        INSERT INTO rejected_opportunities (
          cycle_number, rejected_by, symbol, direction, confidence,
          rejection_reason, rejection_detail, signals_present
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        cycleNumber, 'risk_manager', rej.symbol, rej.direction,
        rej.confidence, rej.rejection_reason, rej.rejection_detail,
        JSON.stringify(rej.signals_present),
      ]);
    } catch (err) {
      console.error('[RISK_MANAGER] Failed to store rejection:', err.message);
    }
  }

  /**
   * Review open positions — swap promptKey to positionReviewer, run via base-agent.
   */
  async reviewPositions({ cycleNumber, broadcast }) {
    const systemState = await this.getSystemState();

    if (systemState.openPositions === 0) {
      console.log('[RISK_MANAGER] No open positions to review');
      return { reviews: [], decision: null };
    }

    const originalPromptKey = this.promptKey;
    try {
      this.promptKey = 'positionReviewer';

      // Use BaseAgent.run() which resolves positionReviewer prompt + context builder
      const result = await super.run({
        symbols: systemState.openTrades.map(t => t.symbol),
        indicators: {},
        marketData: {},
        cycleNumber,
      });

      const parsed = result?.output_json || {};
      return {
        reviews: parsed.reviews || [],
        portfolio_notes: parsed.portfolio_notes,
        meta: parsed.meta,
        decision: result,
      };
    } finally {
      this.promptKey = originalPromptKey;
    }
  }

  parseOutput(text) {
    try {
      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        return { ...parsed, signals: [], overallConfidence: null };
      }
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) return { ...JSON.parse(trimmed), signals: [] };
    } catch {}
    return { approved: [], rejected: [], signals: [], overallConfidence: null };
  }
}

module.exports = RiskManagerAgent;
