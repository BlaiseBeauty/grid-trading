/**
 * Risk Manager (Sonnet) — Validates trade proposals against hard limits.
 * Code enforces, AI recommends. This agent is the last gate before execution.
 */

const BaseAgent = require('../base-agent');
const riskLimitsConfig = require('../../config/risk-limits');
const { getRiskLimits } = riskLimitsConfig;
const { queryOne, queryAll, query } = require('../../db/connection');
const { getLatestCorrelations } = require('../correlation-calculator');

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
    const { passed, codeRejected } = await this.preflightCheck(proposals, systemState);

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

    // Parse Claude's risk assessment — handle both single-proposal and multi-proposal formats
    let assessment = result?.output_json || { approved: [], rejected: [] };

    // If AI returned single-proposal format {decision, original_proposal, modifications},
    // normalize to multi-proposal format {approved: [], rejected: []}
    if (assessment.decision && !assessment.approved) {
      const proposal = passed[0]; // single proposal that was evaluated
      if (assessment.decision === 'approve' || assessment.decision === 'modify') {
        const modifications = assessment.modifications || {};
        assessment = {
          approved: [{ ...proposal, ...modifications, approved_size_pct: modifications.position_size_pct || proposal.position_size_suggestion_pct }],
          rejected: [],
        };
      } else {
        assessment = {
          approved: [],
          rejected: [{ ...proposal, reason: assessment.risk_assessment?.reason || 'risk_manager_rejected', detail: assessment.warnings?.join('; ') }],
        };
      }
    }

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
  async preflightCheck(proposals, state) {
    const passed = [];
    const codeRejected = [];
    const limits = this.getEffectiveLimits(state);

    // Drawdown check — runs once before per-proposal checks
    try {
      const drawdown = await this.computeCurrentDrawdown();
      if (drawdown !== null && drawdown >= limits.MAX_DRAWDOWN_PCT) {
        console.log(`[RISK_MANAGER] MAX_DRAWDOWN_PCT breached: ${drawdown.toFixed(2)}% >= ${limits.MAX_DRAWDOWN_PCT}%`);
        // Trigger SCRAM at crisis level
        await this.triggerDrawdownScram(drawdown, limits.MAX_DRAWDOWN_PCT);
        // Reject ALL proposals
        for (const proposal of proposals || []) {
          codeRejected.push({
            symbol: proposal.symbol,
            direction: proposal.direction,
            confidence: proposal.confidence,
            rejection_reason: 'code_enforced',
            rejection_detail: `max_drawdown_exceeded (${drawdown.toFixed(1)}% >= ${limits.MAX_DRAWDOWN_PCT}%)`,
            signals_present: proposal.supporting_signals,
          });
        }
        return { passed: [], codeRejected };
      }
    } catch (err) {
      console.warn('[RISK_MANAGER] Drawdown check failed, proceeding:', err.message);
    }

    // Fetch correlation matrix for correlated exposure check
    let correlations;
    try {
      correlations = await getLatestCorrelations();
    } catch (err) {
      console.warn('[RISK_MANAGER] Correlation fetch failed, using defaults:', err.message);
      correlations = { BTC_ETH: 0.85, BTC_SOL: 0.85, ETH_SOL: 0.85 };
    }

    for (const proposal of proposals || []) {
      const reasons = [];
      const isExploration = proposal.exploration === true;

      // Max open positions
      if (state.openPositions >= limits.MAX_OPEN_POSITIONS) {
        reasons.push(`max_positions_reached (${state.openPositions}/${limits.MAX_OPEN_POSITIONS})`);
      }

      // Daily loss limit
      if (state.dailyLossPct >= limits.MAX_DAILY_LOSS_PCT) {
        reasons.push(`daily_loss_limit (${state.dailyLossPct.toFixed(1)}% >= ${limits.MAX_DAILY_LOSS_PCT}%)`);
      }

      // Min confidence — exploration proposals get a lower threshold (40%)
      const confidenceThreshold = isExploration ? 40 : limits.MIN_CONFIDENCE_TO_TRADE;
      if (proposal.confidence < confidenceThreshold) {
        reasons.push(`low_confidence (${proposal.confidence} < ${confidenceThreshold}${isExploration ? ' exploration' : ''})`);
      }

      // Min complexity score — exploration proposals need only 1 domain
      const complexityThreshold = isExploration ? 1 : riskLimitsConfig.MIN_SIGNAL_COMPLEXITY;
      if ((proposal.complexity_score || 0) < complexityThreshold) {
        reasons.push(`low_complexity (${proposal.complexity_score || 0} < ${complexityThreshold}${isExploration ? ' exploration' : ''})`);
      }

      // Position size limit
      if ((proposal.position_size_suggestion_pct || 0) > limits.MAX_SINGLE_POSITION_PCT) {
        proposal.position_size_suggestion_pct = limits.MAX_SINGLE_POSITION_PCT;
      }

      // Correlated exposure check
      const correlatedExposure = this.computeCorrelatedExposure(
        proposal, state.openTrades, correlations, state.totalPortfolioValue
      );
      if (correlatedExposure > limits.MAX_CORRELATED_EXPOSURE_PCT) {
        reasons.push(`correlated_exposure_limit (${correlatedExposure.toFixed(1)}% > ${limits.MAX_CORRELATED_EXPOSURE_PCT}%)`);
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

    if (codeRejected.length > 0) {
      for (const rej of codeRejected) {
        console.log(`[RISK_MANAGER] Code-rejected: ${rej.symbol} ${rej.direction} conf=${rej.confidence} — ${rej.rejection_detail}`);
      }
    }
    if (passed.length > 0) {
      console.log(`[RISK_MANAGER] Pre-flight passed: ${passed.map(p => `${p.symbol} ${p.direction} conf=${p.confidence} expl=${!!p.exploration}`).join(', ')}`);
    }

    return { passed, codeRejected };
  }

  /**
   * Compute the total correlated crypto exposure if this proposal is added.
   * For each existing open position, the effective additional exposure from
   * the new trade is: new_size + sum(existing_size * correlation) for all
   * correlated open positions.
   */
  computeCorrelatedExposure(proposal, openTrades, correlations, portfolioValue) {
    if (!portfolioValue || portfolioValue <= 0) return 0;

    const newSizePct = proposal.position_size_suggestion_pct || 0;
    const newSymbol = (proposal.symbol || '').split('/')[0]; // e.g. "BTC"

    // Determine directional sign: long = +1, short = -1
    const newSign = (proposal.direction === 'short' || proposal.direction === 'bearish') ? -1 : 1;

    // Sum correlated exposure from existing open trades
    let correlatedSum = newSizePct;

    for (const trade of openTrades || []) {
      const tradeSymbol = (trade.symbol || '').split('/')[0];
      if (tradeSymbol === newSymbol) continue; // same-symbol dedup handled elsewhere

      // Get correlation between the two symbols
      const pairKey1 = `${newSymbol}_${tradeSymbol}`;
      const pairKey2 = `${tradeSymbol}_${newSymbol}`;
      const corr = correlations[pairKey1] ?? correlations[pairKey2] ?? 0;

      // Only count if correlation > 0.5 (meaningfully correlated)
      if (Math.abs(corr) <= 0.5) continue;

      // Compute existing position size as % of portfolio
      const entryPrice = parseFloat(trade.entry_price) || 0;
      const qty = parseFloat(trade.quantity) || 0;
      const existingSizePct = (entryPrice * qty / portfolioValue) * 100;

      // Directional sign of existing trade
      const existingSign = trade.side === 'sell' ? -1 : 1;

      // If both same direction, correlation adds risk; if opposing, it reduces
      const directionalCorr = corr * newSign * existingSign;

      // Only add to exposure if directionally correlated (same direction + positive corr)
      if (directionalCorr > 0) {
        correlatedSum += existingSizePct * Math.abs(corr);
      }
    }

    return correlatedSum;
  }

  /**
   * Compute current drawdown from high-water mark.
   * Returns drawdown as a positive percentage, or null if insufficient data.
   */
  async computeCurrentDrawdown() {
    // High-water mark: max total_value ever recorded in equity_snapshots
    const hwmRow = await queryOne(
      'SELECT MAX(total_value) as high_water_mark FROM equity_snapshots'
    );
    const highWaterMark = parseFloat(hwmRow?.high_water_mark);
    if (!highWaterMark || highWaterMark <= 0) return null;

    // Current equity: starting capital + realised P&L + unrealised P&L
    const startingCapital = parseFloat(process.env.STARTING_CAPITAL || '10000');
    const [realisedRow, unrealisedRow] = await Promise.all([
      queryOne("SELECT COALESCE(SUM(pnl_realised), 0) as total FROM trades WHERE status = 'closed'"),
      queryOne('SELECT COALESCE(SUM(unrealised_pnl), 0) as total FROM portfolio_state'),
    ]);
    const currentEquity = startingCapital
      + parseFloat(realisedRow?.total || 0)
      + parseFloat(unrealisedRow?.total || 0);

    if (currentEquity >= highWaterMark) return 0; // No drawdown

    const drawdownPct = ((highWaterMark - currentEquity) / highWaterMark) * 100;
    return drawdownPct;
  }

  /**
   * Trigger a SCRAM at crisis level due to drawdown breach.
   * Skips if a SCRAM is already active.
   */
  async triggerDrawdownScram(currentDrawdown, threshold) {
    // Check if SCRAM already active
    const active = await queryOne(
      "SELECT id FROM scram_events WHERE cleared_at IS NULL LIMIT 1"
    );
    if (active) {
      console.log('[RISK_MANAGER] SCRAM already active — skipping drawdown SCRAM trigger');
      return;
    }

    await query(`
      INSERT INTO scram_events (level, trigger_name, trigger_value, threshold_value)
      VALUES ('crisis', 'max_drawdown_exceeded', $1, $2)
    `, [Math.round(currentDrawdown * 100) / 100, threshold]);

    console.log(`[RISK_MANAGER] SCRAM CRISIS activated: drawdown ${currentDrawdown.toFixed(2)}% exceeds ${threshold}%`);
  }

  /**
   * Get effective limits based on bootstrap phase and SCRAM level.
   */
  getEffectiveLimits(state) {
    let limits = getRiskLimits();

    // Apply bootstrap overrides
    const bootstrapOverride = riskLimitsConfig.BOOTSTRAP[state.bootstrapPhase];
    if (bootstrapOverride) {
      limits = { ...limits, ...bootstrapOverride };
    }

    // Apply SCRAM overrides (strictest wins)
    if (state.scramLevel) {
      const scramOverride = riskLimitsConfig.SCRAM[state.scramLevel];
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
    } catch (err) { console.warn('[RISK_MANAGER] JSON parse failed in parseOutput:', err.message); }
    return { approved: [], rejected: [], signals: [], overallConfidence: null };
  }
}

module.exports = RiskManagerAgent;
