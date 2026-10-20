'use strict';

/**
 * Single gate for every path that can start an AI agent cycle
 * (crons, boot cycle, and the manual POST endpoints).
 *
 *   isPaused()        env CYCLES_PAUSED — DEFAULT TRUE when unset (observation mode)
 *   checkBudget()     today's platform_ai_costs spend vs AI_DAILY_BUDGET_USD (default 5)
 *   cycleLimitOk()    max 10 GRID cycles / 24h from cycle_reports
 *   gate(opts)        runs all three and returns { ok, status, error }
 *
 * DB errors in checkBudget()/cycleLimitOk() FAIL CLOSED (cycle is not allowed).
 *
 * Env:
 *   CYCLES_PAUSED=false            re-enable AI cycles (anything but 'false'/'0'/'no' keeps them paused)
 *   AI_DAILY_BUDGET_USD=5          daily AI spend ceiling
 *   ALLOW_MANUAL_WHEN_PAUSED=true  lets a manual endpoint bypass the pause with body {override:true}
 */

const { queryOne } = require('../db/connection');

const GRID_CYCLE_LIMIT_24H = 10;

function isPaused() {
  const v = String(process.env.CYCLES_PAUSED ?? 'true').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'no');
}

function dailyBudgetUsd() {
  const n = parseFloat(process.env.AI_DAILY_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

async function checkBudget() {
  const budget = dailyBudgetUsd();
  try {
    const row = await queryOne(
      `SELECT COALESCE(SUM(cost_usd), 0)::float AS spend FROM platform_ai_costs WHERE created_at >= CURRENT_DATE`
    );
    const spend = parseFloat(row?.spend || 0);
    if (spend >= budget) {
      console.warn(`[CYCLE_GATE] Blocked — today's AI spend $${spend.toFixed(2)} >= budget $${budget.toFixed(2)}`);
      return { ok: false, spend, budget };
    }
    return { ok: true, spend, budget };
  } catch (err) {
    console.error('[CYCLE_GATE] Budget check failed — blocking cycle (fail closed):', err.message);
    return { ok: false, spend: null, budget, error: err.message };
  }
}

async function cycleLimitOk() {
  try {
    const row = await queryOne(
      `SELECT COUNT(*) as cnt FROM cycle_reports WHERE created_at > NOW() - INTERVAL '24 hours'`
    );
    const count = parseInt(row?.cnt || '0');
    if (count >= GRID_CYCLE_LIMIT_24H) {
      console.warn(`[CYCLE_GATE] Blocked — ${count} cycles already ran in the last 24h (limit: ${GRID_CYCLE_LIMIT_24H})`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[CYCLE_GATE] Cycle-limit check failed — blocking cycle (fail closed):', err.message);
    return false;
  }
}

/**
 * Combined gate. opts:
 *   override      true when the caller sent body {override:true} (honoured only if ALLOW_MANUAL_WHEN_PAUSED=true)
 *   checkCycles   also apply the 10-cycles/24h limit (GRID cycles only)
 * Returns { ok: true } or { ok: false, status, error } ready for reply.code(status).send({ error }).
 */
async function gate({ override = false, checkCycles = false } = {}) {
  if (isPaused()) {
    const allowed = override === true && process.env.ALLOW_MANUAL_WHEN_PAUSED === 'true';
    if (!allowed) {
      return { ok: false, status: 423, error: 'AI cycles are paused (CYCLES_PAUSED). Set CYCLES_PAUSED=false to enable.' };
    }
  }
  const budget = await checkBudget();
  if (!budget.ok) {
    return {
      ok: false,
      status: 429,
      error: budget.error
        ? 'Daily AI budget check failed — cycle blocked'
        : `Daily AI budget reached ($${budget.spend.toFixed(2)} of $${budget.budget.toFixed(2)})`,
    };
  }
  if (checkCycles && !(await cycleLimitOk())) {
    return { ok: false, status: 429, error: `Rate limit: ${GRID_CYCLE_LIMIT_24H} cycles per 24h reached (or check failed)` };
  }
  return { ok: true };
}

module.exports = { isPaused, checkBudget, cycleLimitOk, gate, GRID_CYCLE_LIMIT_24H };
