/**
 * Risk Manager (Sonnet) — Validates trade proposals against hard limits.
 * Code enforces, AI recommends. This agent is the last gate before execution.
 *
 * The LLM may only approve / reject / resize proposals that already passed code pre-flight.
 * Every approval then goes through enforceHardLimits() (pure, see ../risk-enforcement.js), which
 * is also applied to standing-order triggers via RiskManagerAgent.checkEntry().
 */

const BaseAgent = require('../base-agent');
const riskLimitsConfig = require('../../config/risk-limits');
const { getRiskLimits } = riskLimitsConfig;
const { queryOne, queryAll, query } = require('../../../../db/connection');
const decisionsDb = require('../../../../db/queries/decisions');
const portfolioDb = require('../../../../db/queries/portfolio');
const contextDb = require('../../../../db/queries/context');
const { getLatestCorrelations } = require('../correlation-calculator');
const { resolveProposal, applySizeMultiplier } = require('../../../../shared/conflict-resolver');
const bus = require('../../../../shared/intelligence-bus');
const enforcement = require('../risk-enforcement');
const {
  enforceHardLimits, mergeRiskDecisions, computeEffectiveLimits,
  computeCorrelatedExposure, normalizeDirection, toFiniteNumber,
} = enforcement;

const FALLBACK_CORRELATION = 0.85; // conservative crypto default, used ONLY when the table is empty

function executionMode() {
  return process.env.LIVE_TRADING_ENABLED === 'true' ? 'live' : 'paper';
}

// ---------------------------------------------------------------------------
// Shared DB-backed risk helpers (ONE equity function for every percent denominator)
// ---------------------------------------------------------------------------

/**
 * Portfolio equity = STARTING_CAPITAL (env, documented fallback 10000) + realised + unrealised.
 * Same function calculateQuantity() sizes positions from (portfolioDb.getPortfolioValue).
 * Throws if equity is not a positive number — callers must fail closed.
 */
async function getEquity() {
  const pv = await portfolioDb.getPortfolioValue();
  const total = Number(pv?.total_value);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`equity unavailable or non-positive (${pv?.total_value})`);
  }
  return pv;
}

/**
 * Rolling-24h loss as a positive % of equity: realised (closed in last 24h) plus any
 * unrealised loss on open positions. Returns 0 when flat/profitable.
 */
async function getRollingDailyLossPct(equityValue) {
  const equity = equityValue ?? (await getEquity()).total_value;
  const [realisedRow, unrealisedRow] = await Promise.all([
    queryOne(`SELECT COALESCE(SUM(pnl_realised), 0) AS total FROM trades
              WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '24 hours'`),
    queryOne('SELECT COALESCE(SUM(unrealised_pnl), 0) AS total FROM portfolio_state'),
  ]);
  const pnl = parseFloat(realisedRow?.total || 0) + Math.min(0, parseFloat(unrealisedRow?.total || 0));
  return pnl < 0 ? (Math.abs(pnl) / equity) * 100 : 0;
}

/**
 * High-water mark = MAX(total_value) since the last hwm_resets marker (never deletes history).
 * Falls back to all-time MAX only if the marker table does not exist yet (stricter, never looser).
 */
async function getHighWaterMark() {
  let row;
  try {
    row = await queryOne(`
      SELECT MAX(total_value) AS hwm FROM equity_snapshots
      WHERE created_at >= COALESCE((SELECT MAX(reset_at) FROM hwm_resets), '-infinity'::timestamptz)
    `);
  } catch (err) {
    if (err.code !== '42P01') throw err;
    console.warn('[RISK_MANAGER] hwm_resets table missing (migration 032 pending) — using all-time high-water mark');
    row = await queryOne('SELECT MAX(total_value) AS hwm FROM equity_snapshots');
  }
  return parseFloat(row?.hwm) || 0;
}

/** Current drawdown % from the (reset-aware) high-water mark; 0 when there is no history. */
async function computeDrawdownPct() {
  const hwm = await getHighWaterMark();
  if (!hwm || hwm <= 0) return 0;
  const equity = (await getEquity()).total_value;
  if (equity >= hwm) return 0;
  return ((hwm - equity) / hwm) * 100;
}

async function triggerDrawdownScram(currentDrawdown, threshold) {
  const active = await queryOne("SELECT id FROM scram_events WHERE cleared_at IS NULL LIMIT 1");
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

/** Strictest active SCRAM row (so a manual 'elevated' can never mask an automatic 'crisis'). */
async function getActiveScram() {
  return queryOne(`
    SELECT * FROM scram_events WHERE cleared_at IS NULL
    ORDER BY CASE level WHEN 'emergency' THEN 3 WHEN 'crisis' THEN 2 ELSE 1 END DESC, activated_at DESC
    LIMIT 1
  `);
}

/** Core DB state used by every percent-based limit. Throws on any DB error (caller fails closed). */
async function loadCoreState() {
  const [pv, openTrades, bootstrap, scram] = await Promise.all([
    getEquity(),
    // 'close_failed' = live close was rejected by the exchange/engine; exposure still exists
    queryAll("SELECT * FROM trades WHERE status IN ('open', 'close_failed')"),
    queryOne('SELECT * FROM bootstrap_status ORDER BY id DESC LIMIT 1'),
    getActiveScram(),
  ]);
  const equity = pv.total_value;
  const dailyLossPct = await getRollingDailyLossPct(equity);
  return {
    equity,
    totalPortfolioValue: equity,
    openPositions: openTrades.length,
    openTrades,
    bootstrapPhase: bootstrap?.phase || 'infant',
    scram,
    scramLevel: scram?.level || null,
    dailyLossPct,
  };
}

/** Pair correlations; logs when the conservative 0.85 constants are used (empty table). */
async function loadCorrelations() {
  const correlations = await getLatestCorrelations();
  if (!correlations || correlations.computed_at == null) {
    console.warn(`[RISK_MANAGER] correlation_matrix empty — using conservative ${FALLBACK_CORRELATION} default constants`);
  }
  return correlations || {};
}

/** Read COMPASS risk state + allocation guidance. Never throws; reports errors in .error. */
async function readCompassState() {
  const out = { available: false, posture: null, score: null, limits: null, guidance: null, error: null };
  try {
    const row = await bus.getRiskState();
    if (row?.payload) {
      const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      out.available = true;
      out.posture = p?.risk_posture ? String(p.risk_posture).toUpperCase() : null;
      out.score = p?.risk_score ?? null;
      out.limits = p?.limits || null;
    }
  } catch (err) {
    out.error = err.message;
    console.error('[RISK_MANAGER] COMPASS risk state read failed:', err.message);
  }
  try {
    const allocation = await bus.getLatestAllocationGuidance();
    if (allocation?.payload) {
      out.guidance = typeof allocation.payload === 'string' ? JSON.parse(allocation.payload) : allocation.payload;
      if (!out.posture && out.guidance?.risk_posture) out.posture = String(out.guidance.risk_posture).toUpperCase();
    }
  } catch (err) {
    console.warn('[RISK_MANAGER] COMPASS allocation guidance unavailable:', err.message);
  }
  return out;
}

/** COMPASS posture is mandatory when trading live (set COMPASS_POSTURE_REQUIRED=false to opt out). */
function compassRequired() {
  return executionMode() === 'live' && process.env.COMPASS_POSTURE_REQUIRED !== 'false';
}

function compassMaxPctFor(compass, equity) {
  const usd = compass?.limits?.max_single_position_usd;
  return usd && equity > 0 ? (usd / equity) * 100 : null;
}

function effectiveLimitsFor(state) {
  return computeEffectiveLimits(state, {
    base: getRiskLimits(),
    bootstrap: riskLimitsConfig.BOOTSTRAP,
    scram: riskLimitsConfig.SCRAM,
  });
}

class RiskManagerAgent extends BaseAgent {
  constructor() {
    super({ name: 'risk_manager', layer: 'strategy', model: require('../../../../shared/models').MODELS.grid_strategy, costTier: 'grid_risk_manager' });
  }

  /**
   * Override run — takes Synthesizer proposals as input.
   */
  async run({ cycleNumber, proposals, broadcast }) {
    const start = Date.now();

    // Current system state. Any DB failure throws -> caller sees "Risk Manager failed" -> no trades.
    const systemState = await this.getSystemState();

    // COMPASS posture is read ONCE (live: mandatory — fail closed when absent/unreadable)
    const compass = await readCompassState();
    const compassPosture = (compass.available || compass.posture)
      ? { risk_posture: compass.posture, risk_score: compass.score }
      : null;

    let passed;
    let codeRejected;
    let correlations = null;
    if (compassRequired() && (compass.error || !compass.available)) {
      const why = compass.error || 'no fresh COMPASS risk state on the bus';
      console.error(`[RISK_MANAGER] COMPASS posture required in live mode but unavailable (${why}) — rejecting all new entries`);
      passed = [];
      codeRejected = (proposals || []).map(p => this.rejectionRecord(p, `risk_check_unavailable (compass_posture: ${why})`));
    } else {
      ({ passed, codeRejected, correlations } = await this.preflightCheck(proposals, systemState, compassPosture));
    }

    // Store code-rejected opportunities
    for (const rej of codeRejected) {
      await this.storeRejection(cycleNumber, rej);
    }

    if (passed.length === 0) {
      console.log('[RISK_MANAGER] All proposals rejected by code-enforced limits');

      // Persist decision even when no AI call was needed (code-enforced rejection)
      const reasoning = codeRejected.map(r =>
        `${r.symbol} ${r.direction} conf=${r.confidence}: ${r.rejection_detail}`
      ).join('\n');
      const outputJson = { reviews: codeRejected, signals: [] };
      let decision = null;
      try {
        decision = await decisionsDb.create({
          agent_name: this.name,
          agent_layer: this.layer,
          cycle_number: cycleNumber,
          model_used: null,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          reasoning,
          confidence_score: null,
          output_json: outputJson,
          duration_ms: Date.now() - start,
          error: null,
        });
      } catch (err) {
        console.error('[RISK_MANAGER] Failed to store code-rejection decision:', err.message);
      }

      return { approved: [], rejected: codeRejected, decision };
    }

    // For surviving proposals, ask Claude for nuanced risk assessment
    const result = await super.run({
      symbols: passed.map(p => p.symbol),
      indicators: {},
      marketData: {},
      cycleNumber,
      _riskContext: { proposals: passed, systemState, codeRejected },
    });

    // The LLM may only approve / reject / resize proposals that passed pre-flight.
    // sl/tp/entry/mode/exploration/symbol/direction ALWAYS come from the pre-flight proposal.
    const assessment = result?.output_json || {};
    const merged = mergeRiskDecisions(assessment, passed);
    for (const d of merged.dropped) {
      console.warn(`[RISK_MANAGER] Ignored LLM decision (${d.reason}): ${JSON.stringify(d.decision).slice(0, 200)}`);
    }
    let approved = merged.approved;
    const rejected = merged.rejected;

    // Store Claude-rejected opportunities
    for (const rej of rejected) {
      await this.storeRejection(cycleNumber, {
        symbol: rej.symbol,
        direction: rej.direction,
        confidence: rej.confidence,
        rejection_reason: rej.reason || 'risk_manager_rejected',
        rejection_detail: rej.detail,
      });
    }

    // Apply Oracle conflict resolver to approved proposals (adjusts sizing; boosts capped at the limit)
    const limits = this.getEffectiveLimits(systemState);
    for (let i = 0; i < approved.length; i++) {
      try {
        approved[i] = await resolveProposal(approved[i]);
        if (approved[i].size_multiplier && approved[i].size_multiplier !== 1.0) {
          const sizePct = approved[i].approved_size_pct || approved[i].position_size_suggestion_pct || 0;
          approved[i].approved_size_pct = applySizeMultiplier(sizePct, approved[i].size_multiplier, limits.MAX_SINGLE_POSITION_PCT);
          console.log(`[RISK_MANAGER] Oracle adjustment: ${approved[i].symbol} ` +
            `size ×${approved[i].size_multiplier} → ${approved[i].approved_size_pct}%`);
        }
      } catch (err) {
        console.warn('[RISK_MANAGER] Conflict resolver failed (non-critical):', err.message);
      }
    }

    // COMPASS limits — caps / direction bias; never increases sizes
    await this.applyCompassLimits(approved, compass, systemState.equity);

    // FINAL AUTHORITY: hard limits after the LLM, after the resolver boost, after COMPASS
    let upcomingEvents = [];
    let eventsError = false;
    try {
      upcomingEvents = await contextDb.getUpcomingEvents(limits.EVENT_BLACKOUT_HOURS || 0);
    } catch (err) {
      eventsError = true;
      console.error('[RISK_MANAGER] events_calendar read failed:', err.message);
    }
    const mode = executionMode();
    const running = {
      ...systemState,
      openTrades: [...systemState.openTrades],
      correlations,
      upcomingEvents,
      eventsError,
      now: new Date(),
    };
    const accepted = [];
    const hardRejected = [];
    for (const cand of approved) {
      const verdict = enforceHardLimits(cand, running, limits, {
        mode,
        compassMaxPct: cand.compass_limits_applied?.max_position_pct ?? undefined,
      });
      if (verdict.ok) {
        accepted.push(verdict.proposal);
        running.openPositions += 1;
        running.openTrades.push({
          symbol: verdict.proposal.symbol,
          side: verdict.proposal.direction === 'long' ? 'buy' : 'sell',
          entry_price: verdict.proposal.entry_price,
          quantity: (verdict.proposal.approved_size_pct / 100 * running.equity) / verdict.proposal.entry_price,
          asset_class: verdict.proposal.asset_class || 'crypto',
        });
        if (verdict.adjustments.length > 0) {
          console.log(`[RISK_MANAGER] Hard-limit adjustments ${cand.symbol}: ${verdict.adjustments.join('; ')}`);
        }
      } else {
        const detail = verdict.reasons.join('; ');
        console.warn(`[RISK_MANAGER] Hard-limit REJECT ${cand.symbol} ${cand.direction}: ${detail}`);
        const rec = this.rejectionRecord(cand, detail);
        hardRejected.push(rec);
        await this.storeRejection(cycleNumber, rec);
      }
    }

    return {
      approved: accepted,
      rejected: [...codeRejected, ...rejected, ...hardRejected],
      decision: result,
    };
  }

  /** Uniform code-rejection record. */
  rejectionRecord(proposal, detail) {
    return {
      symbol: proposal.symbol,
      direction: proposal.direction,
      confidence: proposal.confidence,
      rejection_reason: 'code_enforced',
      reason: 'code_enforced',
      rejection_detail: detail,
      detail,
      signals_present: proposal.supporting_signals,
    };
  }

  /**
   * Hard-coded pre-flight check. Code enforces — AI cannot override these.
   * Fails CLOSED: if drawdown or correlations cannot be computed, every proposal is rejected.
   */
  async preflightCheck(proposals, state, compassPosture = null) {
    const passed = [];
    const codeRejected = [];
    const limits = this.getEffectiveLimits(state);
    const mode = executionMode();
    const rejectAll = (detail) => {
      for (const proposal of proposals || []) codeRejected.push(this.rejectionRecord(proposal, detail));
      return { passed: [], codeRejected, correlations: null };
    };

    // Drawdown check — runs once before per-proposal checks
    try {
      const drawdown = await this.computeCurrentDrawdown();
      if (drawdown !== null && drawdown >= limits.MAX_DRAWDOWN_PCT) {
        console.log(`[RISK_MANAGER] MAX_DRAWDOWN_PCT breached: ${drawdown.toFixed(2)}% >= ${limits.MAX_DRAWDOWN_PCT}%`);
        try {
          await this.triggerDrawdownScram(drawdown, limits.MAX_DRAWDOWN_PCT);
        } catch (scramErr) {
          console.error('[RISK_MANAGER] Drawdown SCRAM trigger failed (proposals still rejected):', scramErr.message);
        }
        return rejectAll(`max_drawdown_exceeded (${drawdown.toFixed(1)}% >= ${limits.MAX_DRAWDOWN_PCT}%)`);
      }
    } catch (err) {
      console.error('[RISK_MANAGER] Drawdown check failed — rejecting (fail closed):', err.message);
      return rejectAll(`risk_check_unavailable (drawdown: ${err.message})`);
    }

    // Fetch correlation matrix for correlated exposure check
    let correlations;
    try {
      correlations = await loadCorrelations();
    } catch (err) {
      console.error('[RISK_MANAGER] Correlation fetch failed — rejecting (fail closed):', err.message);
      return rejectAll(`risk_check_unavailable (correlations: ${err.message})`);
    }

    for (const proposal of proposals || []) {
      const reasons = [];
      const isExploration = proposal.exploration === true;
      const dir = normalizeDirection(proposal.direction);
      if (!dir) reasons.push('invalid_direction');

      // COMPASS posture — code-enforced directional controls (live trading only)
      // In paper mode posture is advisory — Synthesizer already sees it in context.
      if (mode === 'live') {
        if (compassPosture?.risk_posture === 'CASH') {
          if (dir === 'long') {
            reasons.push(`compass_posture_block (CASH — long trades banned, risk=${compassPosture.risk_score}/10)`);
          }
        } else if (compassPosture?.risk_posture === 'DEFENSIVE') {
          if (dir === 'long') {
            // Halve position size — conservative participation, not a ban
            proposal.position_size_suggestion_pct = Math.max(
              1,
              Math.round((proposal.position_size_suggestion_pct || 5) * 0.5 * 100) / 100
            );
            console.log(`[RISK_MANAGER] DEFENSIVE posture: ${proposal.symbol} long size halved to ${proposal.position_size_suggestion_pct}%`);
          }
        }
      }

      // Max open positions
      if (state.openPositions >= limits.MAX_OPEN_POSITIONS) {
        reasons.push(`max_positions_reached (${state.openPositions}/${limits.MAX_OPEN_POSITIONS})`);
      }

      // Daily loss limit (rolling 24h incl. unrealised, % of equity)
      if (state.dailyLossPct >= limits.MAX_DAILY_LOSS_PCT) {
        reasons.push(`daily_loss_limit (${state.dailyLossPct.toFixed(1)}% >= ${limits.MAX_DAILY_LOSS_PCT}%)`);
      }

      // Confidence must be a real number (NaN < x is false and would otherwise slip through)
      const confidence = toFiniteNumber(proposal.confidence);
      const confidenceThreshold = isExploration ? 40 : limits.MIN_CONFIDENCE_TO_TRADE;
      if (!Number.isFinite(confidence)) {
        reasons.push('invalid_confidence');
      } else if (confidence < confidenceThreshold) {
        reasons.push(`low_confidence (${confidence} < ${confidenceThreshold}${isExploration ? ' exploration' : ''})`);
      }

      // Min complexity score — exploration proposals need 3 domains (prompt and code aligned)
      const complexityThreshold = isExploration ? 3 : limits.MIN_SIGNAL_COMPLEXITY;
      if ((proposal.complexity_score || 0) < complexityThreshold) {
        reasons.push(`low_complexity (${proposal.complexity_score || 0} < ${complexityThreshold}${isExploration ? ' exploration_min_3_domains' : ''})`);
      }

      // Position size limit
      if ((proposal.position_size_suggestion_pct || 0) > limits.MAX_SINGLE_POSITION_PCT) {
        proposal.position_size_suggestion_pct = limits.MAX_SINGLE_POSITION_PCT;
      }

      // Correlated exposure check
      const correlatedExposure = this.computeCorrelatedExposure(
        proposal, state.openTrades, correlations, state.equity
      );
      if (correlatedExposure > limits.MAX_CORRELATED_EXPOSURE_PCT) {
        reasons.push(`correlated_exposure_limit (${correlatedExposure.toFixed(1)}% > ${limits.MAX_CORRELATED_EXPOSURE_PCT}%)`);
      }

      // A stop-loss is mandatory; levels must sit on the correct side; R:R uses SIGNED distances
      const entry = toFiniteNumber(proposal.entry_price);
      const sl = toFiniteNumber(proposal.sl_price);
      const tp = toFiniteNumber(proposal.tp_price);
      if (!(sl > 0)) {
        reasons.push('missing_stop_loss');
      } else if (entry > 0 && dir) {
        const sign = dir === 'long' ? 1 : -1;
        const risk = sign * (entry - sl);
        if (!(risk > 0)) {
          reasons.push(`stop_wrong_side (${dir} entry=${entry} sl=${sl})`);
        } else if (tp > 0) {
          const reward = sign * (tp - entry) - entry * enforcement.ROUND_TRIP_COST_PCT;
          if (!(sign * (tp - entry) > 0)) {
            reasons.push(`target_wrong_side (${dir} entry=${entry} tp=${tp})`);
          } else if (reward / risk < limits.MIN_RISK_REWARD_RATIO) {
            reasons.push(`low_risk_reward (fee-adjusted R:R ${(reward / risk).toFixed(2)} < ${limits.MIN_RISK_REWARD_RATIO})`);
          }
        }
      }

      // SCRAM check
      if (state.scramLevel === 'crisis' || state.scramLevel === 'emergency') {
        reasons.push(`scram_active (${state.scramLevel})`);
      }

      // Bootstrap paper-only check — uses the REAL execution mode (proposal.mode is never set)
      if (limits.PAPER_ONLY && mode === 'live') {
        reasons.push('bootstrap_paper_only');
      }

      if (reasons.length > 0) {
        codeRejected.push(this.rejectionRecord(proposal, reasons.join('; ')));
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

    return { passed, codeRejected, correlations };
  }

  /**
   * Total correlated crypto exposure (% of equity) if this proposal is added.
   * Thin wrapper over the pure implementation.
   */
  computeCorrelatedExposure(proposal, openTrades, correlations, portfolioValue) {
    return computeCorrelatedExposure({
      symbol: proposal.symbol,
      direction: proposal.direction,
      sizePct: proposal.approved_size_pct || proposal.position_size_suggestion_pct || 0,
    }, openTrades, correlations, portfolioValue);
  }

  /**
   * Current drawdown % from the reset-aware high-water mark (0 when no history).
   * Throws on DB error — callers must fail closed.
   */
  async computeCurrentDrawdown() {
    return computeDrawdownPct();
  }

  /** Trigger a SCRAM at crisis level due to drawdown breach (skips if one is already active). */
  async triggerDrawdownScram(currentDrawdown, threshold) {
    return triggerDrawdownScram(currentDrawdown, threshold);
  }

  /**
   * Effective limits: base ∩ bootstrap phase ∩ SCRAM level — strictest value always wins.
   */
  getEffectiveLimits(state) {
    return effectiveLimitsFor(state || {});
  }

  /**
   * Current system state for limit checking (equity-based percentages, rolling-24h daily loss).
   */
  async getSystemState() {
    return loadCoreState();
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

  /**
   * Apply COMPASS limits to approved proposals.
   * Reads risk state and allocation guidance from the intelligence bus.
   * Falls back gracefully if COMPASS is unavailable.
   */
  async applyCompassLimits(approved, compass = null, equity = null) {
    if (approved.length === 0) return;

    // The caller normally passes the COMPASS state it already read; read it once if not.
    const state = compass || await readCompassState();
    const equityValue = equity ?? (await getEquity()).total_value;
    const compassLimits = state.limits || null;
    if (compassLimits) {
      console.log(
        `[RISK_MANAGER] Using COMPASS limits: ` +
        `max_position=$${compassLimits.max_single_position_usd}, ` +
        `risk_score=${state.score}/10`
      );
    }
    const compassGuidance = state.guidance || null;

    for (const proposal of approved) {
      const sizePct = proposal.approved_size_pct || proposal.position_size_suggestion_pct || 0;
      const compassMaxPct = compassMaxPctFor(state, equityValue);

      // Apply COMPASS position size cap (USD limit as % of live equity, not starting capital)
      if (compassMaxPct != null && sizePct > compassMaxPct) {
        console.log(
          `[RISK_MANAGER] COMPASS cap: ${proposal.symbol} ` +
          `${sizePct.toFixed(1)}% → ${compassMaxPct.toFixed(1)}%`
        );
        proposal.approved_size_pct = Math.floor(compassMaxPct * 100) / 100;
      }

      // Apply COMPASS direction bias — reduce size 25% if opposing
      if (compassGuidance?.recommended_weights) {
        const symbolGuidance = compassGuidance.recommended_weights[proposal.symbol];
        if (symbolGuidance) {
          const compassDir = symbolGuidance.direction;
          const proposalDir = normalizeDirection(proposal.direction) === 'long' ? 'long' : 'short';
          if (compassDir && compassDir !== 'neutral' && compassDir !== proposalDir) {
            const currentSize = proposal.approved_size_pct || sizePct;
            proposal.approved_size_pct = Math.round(currentSize * 0.75 * 100) / 100;
            console.log(
              `[RISK_MANAGER] COMPASS direction bias (${compassDir}) opposes ` +
              `proposal (${proposalDir}) — size reduced 25%`
            );
          }
        }
      }

      // Attach COMPASS metadata (max_position_pct feeds enforceHardLimits as a hard ceiling)
      proposal.compass_limits_applied = {
        source:           compassLimits ? 'compass' : 'fallback',
        max_position_usd: compassLimits?.max_single_position_usd || null,
        max_position_pct: compassMaxPct,
        risk_score:       compassLimits ? (compassGuidance?.risk_score || null) : null,
      };
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

/**
 * Final entry gate for paths that do not go through the LLM risk manager (standing orders).
 * Loads state, checks drawdown / SCRAM / COMPASS posture, then runs enforceHardLimits().
 * Fails CLOSED: any DB/check error returns ok:false with reason 'risk_check_unavailable'.
 *
 * @param {object} proposal  { symbol, direction, confidence, entry_price, sl_price, tp_price,
 *                             approved_size_pct, asset_class, exploration }
 * @returns {Promise<{ok:boolean, reasons:string[], adjustments:string[], proposal:object|null}>}
 */
async function checkEntry(proposal) {
  const unavailable = (what, err) => {
    console.error(`[RISK_MANAGER] checkEntry ${what} failed — rejecting (fail closed):`, err.message);
    return { ok: false, reasons: [`risk_check_unavailable (${what}: ${err.message})`], adjustments: [], proposal: null };
  };
  let state;
  try {
    state = await loadCoreState();
  } catch (err) {
    return unavailable('state', err);
  }
  const limits = effectiveLimitsFor(state);

  try {
    const drawdown = await computeDrawdownPct();
    if (drawdown >= limits.MAX_DRAWDOWN_PCT) {
      try { await triggerDrawdownScram(drawdown, limits.MAX_DRAWDOWN_PCT); }
      catch (e) { console.error('[RISK_MANAGER] Drawdown SCRAM trigger failed:', e.message); }
      return { ok: false, reasons: [`max_drawdown_exceeded (${drawdown.toFixed(1)}% >= ${limits.MAX_DRAWDOWN_PCT}%)`], adjustments: [], proposal: null };
    }
  } catch (err) {
    return unavailable('drawdown', err);
  }

  let correlations;
  try {
    correlations = await loadCorrelations();
  } catch (err) {
    return unavailable('correlations', err);
  }

  const compass = await readCompassState();
  if (compassRequired() && (compass.error || !compass.available)) {
    return unavailable('compass_posture', new Error(compass.error || 'no fresh COMPASS risk state'));
  }
  if (executionMode() === 'live' && compass.posture === 'CASH' && normalizeDirection(proposal.direction) === 'long') {
    return { ok: false, reasons: ['compass_posture_block (CASH — long trades banned)'], adjustments: [], proposal: null };
  }

  let upcomingEvents = [];
  let eventsError = false;
  try {
    upcomingEvents = await contextDb.getUpcomingEvents(limits.EVENT_BLACKOUT_HOURS || 0);
  } catch (err) {
    eventsError = true;
    console.error('[RISK_MANAGER] events_calendar read failed:', err.message);
  }

  return enforceHardLimits(proposal, {
    ...state, correlations, upcomingEvents, eventsError, now: new Date(),
  }, limits, {
    mode: executionMode(),
    compassMaxPct: compassMaxPctFor(compass, state.equity) ?? undefined,
  });
}

module.exports = RiskManagerAgent;
// Pure / shared helpers (also importable from ../risk-enforcement for DB-free unit tests)
module.exports.enforceHardLimits = enforceHardLimits;
module.exports.mergeRiskDecisions = mergeRiskDecisions;
module.exports.computeEffectiveLimits = computeEffectiveLimits;
module.exports.checkEntry = checkEntry;
module.exports.getEquity = getEquity;
module.exports.getRollingDailyLossPct = getRollingDailyLossPct;
module.exports.getHighWaterMark = getHighWaterMark;
module.exports.computeDrawdownPct = computeDrawdownPct;
module.exports.getActiveScram = getActiveScram;
module.exports.loadRiskCoreState = loadCoreState;
module.exports.loadCorrelations = loadCorrelations;
module.exports.readCompassState = readCompassState;
module.exports.compassRequired = compassRequired;
module.exports.executionMode = executionMode;
