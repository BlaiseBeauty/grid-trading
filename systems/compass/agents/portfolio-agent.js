'use strict';

const CompassBaseAgent     = require('./base-agent');
const { buildCompassContext } = require('./context-builder');
const { query }            = require('../../../db/connection');
const bus                  = require('../../../shared/intelligence-bus');

const PORTFOLIO_SYSTEM_PROMPT = `You are the COMPASS Portfolio Agent.
You synthesise macro intelligence (from ORACLE) and trading performance (from GRID)
into portfolio allocation guidance. You do NOT trade — you publish guidance that
GRID uses to govern its position sizing.

Your output must answer:
1. What is the current risk posture? (aggressive/neutral/defensive/cash)
2. What is the recommended allocation across tracked symbols?
3. What cash/defensive weight is appropriate right now?

TRACKED SYMBOLS: BTC, ETH, SOL (GRID's current universe)
RISK POSTURE DEFINITIONS:
- aggressive: high-conviction thesis alignment, strong performance, max 20% cash
- neutral:    mixed signals, normal GRID operation, 20-30% cash buffer
- defensive:  conflicting theses, poor recent performance, 40-50% cash buffer
- cash:       major macro risk, ORACLE bear theses dominant, >50% cash, minimal exposure

OUTPUT: Return ONLY valid JSON matching this schema exactly:
{
  "risk_posture": "neutral",
  "posture_reasoning": "2-3 sentences explaining why this posture",
  "cash_weight": 0.25,
  "recommended_weights": {
    "BTC": {
      "weight": 0.35,
      "direction": "long",
      "max_position_usd": 5000,
      "recommended_usd": 3500,
      "bias_conviction": 7.5,
      "reasoning": "One sentence"
    }
  },
  "rebalance_actions": [
    {
      "action": "reduce_btc",
      "symbol": "BTC",
      "reason": "Why",
      "urgency": "normal"
    }
  ],
  "key_risks": ["Risk 1", "Risk 2"]
}

RULES:
- recommended_weights must sum to approximately (1.0 - cash_weight)
- max_position_usd cannot exceed 10000 (hard cap from risk-limits.js)
- If ORACLE has no active theses, default to neutral posture
- If GRID win_rate < 40% in last period, force defensive posture
- If GRID max_drawdown > 8%, force cash posture
- Never recommend a direction that conflicts with a structural ORACLE thesis > 8.5/10`;

async function runPortfolioAgent() {
  console.log('[COMPASS-PORTFOLIO] Running portfolio agent...');

  const context = await buildCompassContext();
  const agent   = new CompassBaseAgent({
    name:     'compass-portfolio',
    model:    'claude-opus-4-5',
    costTier: 'compass_portfolio',
  });

  // Performance-based posture guardrails
  // These override Claude's posture suggestion if hard thresholds are breached
  let postureOverride = null;

  if (context.latestDigest?.payload) {
    const digest = typeof context.latestDigest.payload === 'string'
      ? JSON.parse(context.latestDigest.payload)
      : context.latestDigest.payload;

    const winRate      = parseFloat(digest.win_rate || 0);
    const drawdownPct  = parseFloat(digest.max_drawdown_pct || 0);
    const totalTrades  = parseInt(digest.total_trades || 0);

    // Only apply guardrails if we have meaningful sample size
    if (totalTrades >= 5) {
      if (drawdownPct >= 8.0) {
        postureOverride = 'cash';
        console.log(`[COMPASS-PORTFOLIO] OVERRIDE: Drawdown ${drawdownPct}% >= 8% → forcing CASH posture`);
      } else if (drawdownPct >= 5.0 || winRate < 40) {
        postureOverride = 'defensive';
        console.log(`[COMPASS-PORTFOLIO] OVERRIDE: Performance weak (drawdown ${drawdownPct}%, win ${winRate}%) → forcing DEFENSIVE`);
      }
    }
  }

  // Inject override into system prompt if triggered
  const postureInstruction = postureOverride
    ? `\n\nIMPORTANT OVERRIDE: GRID performance thresholds have been breached. ` +
      `You MUST set risk_posture to "${postureOverride}" regardless of thesis context.`
    : '';

  const effectiveSystemPrompt = PORTFOLIO_SYSTEM_PROMPT + postureInstruction;

  const userPrompt = `
ORACLE ACTIVE THESES (${context.activeTheses.length} total):
${context.thesisSummary}

GRID RECENT PERFORMANCE:
${context.performanceSummary}

CURRENT OPEN POSITIONS:
${context.positionsSummary}
Total current exposure: $${context.totalExposureUsd.toFixed(2)}

PREVIOUS COMPASS POSTURE: ${context.previousPosture}

Based on this context, determine the appropriate portfolio allocation and risk posture.
Return ONLY valid JSON.`;

  try {
    const raw    = await agent.callClaude(effectiveSystemPrompt, userPrompt);
    const result = agent.parseJSON(raw);

    if (!result) throw new Error('Portfolio agent produced invalid JSON');

    // Validate and clamp values
    result.cash_weight = Math.max(0, Math.min(1, parseFloat(result.cash_weight) || 0.25));

    for (const [symbol, alloc] of Object.entries(result.recommended_weights || {})) {
      alloc.max_position_usd = Math.min(
        parseFloat(alloc.max_position_usd) || 3000,
        10000 // hard cap — never exceed risk-limits.js HARD_CAP
      );
      alloc.recommended_usd = Math.min(
        parseFloat(alloc.recommended_usd) || alloc.max_position_usd * 0.7,
        alloc.max_position_usd
      );
    }

    // Persist to DB
    const portfolioResult = await query(
      `INSERT INTO compass_portfolios
         (recommended_weights, cash_weight, risk_posture, posture_reasoning,
          oracle_thesis_count, grid_sharpe, grid_win_rate, grid_drawdown_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        JSON.stringify(result.recommended_weights),
        result.cash_weight,
        result.risk_posture || 'neutral',
        result.posture_reasoning || '',
        context.activeTheses.length,
        null, // sharpe from digest
        null, // win_rate from digest
        null, // drawdown from digest
      ]
    );

    const portfolioId = portfolioResult.rows[0].id;

    // Persist per-symbol allocations
    const validUntil = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6h validity
    for (const [symbol, alloc] of Object.entries(result.recommended_weights || {})) {
      // Find if any thesis aligns with this symbol
      const alignedThesis = context.activeTheses.find(t => {
        const p = typeof t.payload === 'string' ? JSON.parse(t.payload) : t.payload;
        return (p?.long_assets || []).includes(symbol) ||
               (p?.short_assets || []).includes(symbol);
      });

      await query(
        `INSERT INTO compass_allocations
           (portfolio_id, symbol, max_position_usd, recommended_usd,
            direction_bias, bias_conviction, primary_thesis_id, valid_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          portfolioId, symbol,
          alloc.max_position_usd, alloc.recommended_usd,
          alloc.direction || 'neutral',
          alloc.bias_conviction || null,
          alignedThesis?.payload?.thesis_id || null,
          validUntil,
        ]
      );
    }

    // Log rebalance recommendations
    for (const action of result.rebalance_actions || []) {
      await query(
        `INSERT INTO compass_rebalance_log
           (action, symbol, reason, urgency)
         VALUES ($1,$2,$3,$4)`,
        [action.action, action.symbol || null, action.reason, action.urgency || 'normal']
      );
    }

    // Publish to intelligence bus — GRID reads this for position sizing
    const busId = (await bus.publish({
      source_system: 'compass',
      event_type:    'allocation_guidance',
      payload: {
        portfolio_id:        portfolioId,
        risk_posture:        result.risk_posture,
        cash_weight:         result.cash_weight,
        recommended_weights: result.recommended_weights,
        rebalance_actions:   result.rebalance_actions || [],
        key_risks:           result.key_risks || [],
      },
      expires_at: validUntil.toISOString(),
    }))?.id;

    // Update portfolio record with bus ID
    await query(
      'UPDATE compass_portfolios SET bus_event_id = $1 WHERE id = $2',
      [busId, portfolioId]
    );

    console.log(
      `[COMPASS-PORTFOLIO] Posture: ${result.risk_posture}, ` +
      `Cash: ${(result.cash_weight * 100).toFixed(0)}%, ` +
      `Symbols: ${Object.keys(result.recommended_weights || {}).join(',')} ` +
      `(bus:${busId})`
    );

    return result;

  } catch (err) {
    console.error('[COMPASS-PORTFOLIO] Failed:', err.message);
    throw err;
  }
}

module.exports = { runPortfolioAgent };
