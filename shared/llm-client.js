'use strict';

/**
 * Shared LLM plumbing for GRID, ORACLE and COMPASS agents.
 *
 *  - ONE lazily-created Anthropic client (SDK retries disabled; we own retry policy)
 *  - daily-budget gate + input-token budget enforcement before every call
 *  - bounded retry (3 attempts) with jitter and retry-after on 429 / 5xx / 529
 *  - request timeout
 *  - cost recording through aiCosts.recordUsage (one write path, failures included)
 *  - JSON extraction: fence stripping, outermost-object slice, truncated-array recovery
 *  - rate-limit-aware inter-batch delay
 *
 * Pure helpers (extractJson, recoverArrays, parseRetryAfterMs, backoffMs) are exported
 * for offline unit tests. The Anthropic client and sleep are injectable.
 */

const aiCosts = require('./ai-costs');

const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10);
const MAX_RETRY_WAIT_MS = 60000;

let _client = null;
let _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getClient() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  }
  return _client;
}

// Test hooks
function _setClient(c) { _client = c; }
function _setSleep(fn) { _sleep = fn; }

// ── RETRY POLICY ──────────────────────────────────────────────────────────────

function isRetryable(err) {
  const s = err?.status;
  if (s === 429 || s === 529 || (typeof s === 'number' && s >= 500 && s <= 599)) return true;
  if (err?.error?.type === 'overloaded_error') return true;
  const name = err?.name || '';
  const code = err?.code || '';
  // network-level failures / timeouts
  return /Timeout|Connection/i.test(name) || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code);
}

/** Parse a retry-after header (seconds or HTTP date) into ms; null if absent/invalid. */
function parseRetryAfterMs(err, now = Date.now()) {
  const h = err?.headers;
  let v = null;
  if (h) v = typeof h.get === 'function' ? h.get('retry-after') : (h['retry-after'] || h['Retry-After']);
  if (v == null || v === '') return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Exponential backoff with full jitter, bounded; honours retry-after when larger. */
function backoffMs(attempt, err, rand = Math.random) {
  const base = (err?.status === 429 || err?.status === 529) ? 5000 : 2000;
  const exp = Math.min(MAX_RETRY_WAIT_MS, base * Math.pow(2, attempt - 1));
  const jittered = Math.floor(exp / 2 + rand() * (exp / 2));
  const ra = parseRetryAfterMs(err);
  return Math.min(MAX_RETRY_WAIT_MS, Math.max(jittered, ra || 0));
}

/**
 * Delay between sequential agent batches. Configurable via LLM_BATCH_DELAY_MS
 * (default 20000); doubled-up delay only if the last call saw a 429 (see noteRateLimit).
 */
let _lastRateLimitAt = 0;
function noteRateLimit() { _lastRateLimitAt = Date.now(); }
function batchDelayMs() {
  const base = parseInt(process.env.LLM_BATCH_DELAY_MS || '20000', 10);
  const b = Number.isFinite(base) && base >= 0 ? base : 20000;
  const recentlyLimited = Date.now() - _lastRateLimitAt < 5 * 60 * 1000;
  return recentlyLimited ? Math.min(b * 3, 120000) : b;
}
async function waitBetweenBatches(label = 'batch') {
  const ms = batchDelayMs();
  if (ms > 0) {
    console.log(`[LLM] ${label} complete, waiting ${Math.round(ms / 1000)}s (rate-limit spacing)...`);
    await _sleep(ms);
  }
}

// ── JSON EXTRACTION ───────────────────────────────────────────────────────────

/** Strip ```json fences (closed or unterminated) and return the inner text. */
function stripFences(text) {
  const t = String(text ?? '');
  const closed = t.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/);
  if (closed) return closed[1];
  const open = t.match(/```(?:json|JSON)?\s*([\s\S]*)$/); // unterminated fence = truncated output
  if (open) return open[1];
  return t;
}

/**
 * Pull complete {...} objects out of the named top-level arrays of a (possibly
 * truncated) JSON text. String-aware brace matching.
 * @returns {{ [key: string]: object[] }} only keys with >= 1 recovered object
 */
function recoverArrays(text, keys) {
  const out = {};
  const src = String(text ?? '');
  for (const key of keys) {
    const keyIdx = src.indexOf(`"${key}"`);
    if (keyIdx === -1) continue;
    const arrayStart = src.indexOf('[', keyIdx);
    if (arrayStart === -1) continue;

    const objects = [];
    let depth = 0, objStart = -1, inStr = false, esc = false;
    for (let i = arrayStart + 1; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') { if (depth === 0) objStart = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && objStart >= 0) {
          try { objects.push(JSON.parse(src.substring(objStart, i + 1))); }
          catch (_err) { /* malformed object: skipped, counted via skipped below */ out[`__skipped_${key}`] = (out[`__skipped_${key}`] || 0) + 1; }
          objStart = -1;
        } else if (depth < 0) {
          break; // end of the array's parent
        }
      } else if (ch === ']' && depth === 0) {
        break; // array closed
      }
    }
    if (objects.length > 0) out[key] = objects;
  }
  return out;
}

/**
 * Extract a JSON object from LLM text.
 * @param {string} text
 * @param {{ arrayKeys?: string[] }} [opts] keys for truncation recovery
 * @returns {{ ok: boolean, value: object|null, recovered: boolean, error: string|null }}
 */
function extractJson(text, opts = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: false, value: null, recovered: false, error: 'empty response' };

  const candidate = stripFences(raw).trim();
  const attempts = [candidate];
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) attempts.push(candidate.slice(start, end + 1));

  let lastErr = null;
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v, recovered: false, error: null };
      lastErr = 'JSON is not an object';
    } catch (err) {
      lastErr = err.message;
    }
  }

  const keys = opts.arrayKeys || [];
  if (keys.length) {
    const rec = recoverArrays(candidate.includes('{') ? candidate : raw, keys);
    const found = Object.keys(rec).filter((k) => !k.startsWith('__skipped_'));
    if (found.length > 0) {
      const value = {};
      for (const k of found) value[k] = rec[k];
      return { ok: true, value, recovered: true, error: null };
    }
  }
  return { ok: false, value: null, recovered: false, error: lastErr || 'no JSON found' };
}

// ── CALL ──────────────────────────────────────────────────────────────────────

function logPrefix(opts) {
  return `[${String(opts.agentName || 'llm').toUpperCase()}${opts.cycleId != null ? ` c${opts.cycleId}` : ''}]`;
}

/**
 * One Claude call with budget gates, bounded retry, and cost recording.
 *
 * @param {object} o
 * @param {'grid'|'compass'|'oracle'} o.source
 * @param {string} o.agentName
 * @param {number|null} [o.cycleId]    integer cycle id/number (propagated to cost rows and logs)
 * @param {string} o.model
 * @param {string} o.costTier          key of aiCosts.TOKEN_BUDGETS
 * @param {string} o.system
 * @param {string} o.user
 * @param {number} [o.maxTokens]       clamped to the tier's max_output
 * @param {number} [o.timeoutMs]
 * @param {boolean} [o.retryOnTruncate]  one extra call, only if more output tokens are allowed by the clamp
 * @param {(user:string)=>string} [o.compressOnTruncate]  optional prompt compressor for the truncation retry
 * @returns {Promise<{text:string,stopReason:string|null,inputTokens:number,outputTokens:number,costUsd:number,model:string,attempts:number,inputTruncated:boolean,truncationRetried:boolean}>}
 * @throws {BudgetExceededError|InputBudgetExceededError|Error} the last API error after retries
 */
async function callClaude(o) {
  const tag = logPrefix(o);
  const budget = aiCosts.getBudget(o.costTier);
  const maxTokens = Math.min(o.maxTokens || budget.max_output, budget.max_output);

  // 1. Daily spend gate
  await aiCosts.assertWithinDailyBudget({ source_system: o.source, agent_name: o.agentName });

  // 2. Input token budget
  let user = o.user;
  let inputTruncated = false;
  const mode = aiCosts.inputBudgetMode();
  if (mode !== 'off') {
    const maxIn = aiCosts.getMaxInputTokens(o.costTier);
    const est = aiCosts.estimateTokens(o.system, user);
    if (est > maxIn) {
      if (mode === 'throw') {
        console.error(`${tag} input ~${est} tokens exceeds ${o.costTier} budget ${maxIn} — refused`);
        throw new aiCosts.InputBudgetExceededError(
          `Input ~${est} tokens exceeds ${o.costTier} budget ${maxIn}`,
          { estimated: est, max_input: maxIn, tier: o.costTier }
        );
      }
      const fit = aiCosts.fitInputToBudget(o.system, user, maxIn);
      console.warn(`${tag} input over budget (~${fit.before} > ${maxIn} tokens, tier ${o.costTier}); truncated lowest-priority context to ~${fit.after}`);
      user = fit.text;
      inputTruncated = true;
    }
  }

  const call = async (userText, outTokens) => {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await getClient().messages.create(
          {
            model: o.model,
            max_tokens: outTokens,
            system: o.system,
            messages: [{ role: 'user', content: userText }],
          },
          { timeout: o.timeoutMs || DEFAULT_TIMEOUT_MS, maxRetries: 0 }
        );
        return { response, attempt };
      } catch (err) {
        lastErr = err;
        if (err?.status === 429) noteRateLimit();
        if (isRetryable(err) && attempt < MAX_ATTEMPTS) {
          const wait = backoffMs(attempt, err);
          console.warn(`${tag} API error ${err.status || err.code || err.name}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait / 1000)}s`);
          await _sleep(wait);
          continue;
        }
        // Final failure: record it (tokens unknown => 0) so failed calls are visible in cost rows.
        await aiCosts.recordUsage({
          source_system: o.source, agent_name: o.agentName, model: o.model,
          cycle_id: o.cycleId ?? null, input_tokens: 0, output_tokens: 0,
          status: 'failed', error: err?.message || String(err),
        });
        throw err;
      }
    }
    throw lastErr;
  };

  const record = (response, status) => aiCosts.recordUsage({
    source_system: o.source, agent_name: o.agentName,
    model: response.model || o.model, cycle_id: o.cycleId ?? null,
    input_tokens: response.usage?.input_tokens || 0,
    output_tokens: response.usage?.output_tokens || 0,
    status,
  });

  const first = await call(user, maxTokens);
  let response = first.response;
  let text = response.content?.find((b) => b.type === 'text')?.text ?? response.content?.[0]?.text ?? '';
  let inputTokens = response.usage?.input_tokens || 0;
  let outputTokens = response.usage?.output_tokens || 0;
  let costUsd = await record(response, response.stop_reason === 'max_tokens' ? 'truncated' : 'ok');
  let truncationRetried = false;

  // 3. Truncation retry — never exceeds the tier's output clamp
  if (response.stop_reason === 'max_tokens' && o.retryOnTruncate) {
    const retryMax = Math.min(maxTokens * 2, budget.max_output);
    if (retryMax > maxTokens) {
      console.warn(`${tag} response truncated at ${outputTokens} tokens — retrying once with max_tokens=${retryMax}`);
      try {
        let retryUser = user;
        if (typeof o.compressOnTruncate === 'function') {
          try { retryUser = o.compressOnTruncate(user) || user; }
          catch (cErr) { console.warn(`${tag} compressOnTruncate failed, using full prompt:`, cErr.message); }
        }
        const second = await call(retryUser, retryMax);
        const r2 = second.response;
        const t2 = r2.content?.find((b) => b.type === 'text')?.text ?? r2.content?.[0]?.text ?? '';
        const cost2 = await record(r2, r2.stop_reason === 'max_tokens' ? 'truncated' : 'ok');
        if (t2) text = t2;
        inputTokens += r2.usage?.input_tokens || 0;
        outputTokens += r2.usage?.output_tokens || 0;
        costUsd += cost2;
        response = r2;
        truncationRetried = true;
      } catch (retryErr) {
        console.warn(`${tag} truncation retry failed:`, retryErr.message);
      }
    } else {
      console.warn(`${tag} response truncated but output clamp (${budget.max_output}) leaves no room to retry`);
    }
  }

  return {
    text,
    stopReason: response.stop_reason || null,
    inputTokens,
    outputTokens,
    costUsd,
    model: response.model || o.model,
    attempts: first.attempt,
    inputTruncated,
    truncationRetried,
  };
}

// ── CROSS-SYSTEM DECISION LOG (ORACLE / COMPASS) ──────────────────────────────

/**
 * Write an agent_decisions row for an ORACLE/COMPASS call, tagged with source_system
 * so GRID analytics can exclude it. Falls back to the legacy column set if migration
 * 041 (source_system column) has not been applied yet.
 */
async function logForeignDecision({ source, agentName, layer, model, inputTokens, outputTokens, costUsd, text, cycleId }) {
  const { query } = require('../db/connection');
  // cycle_number is deliberately NOT set: ORACLE/COMPASS cycle ids are epoch seconds and would
  // corrupt GRID's MAX(cycle_number)/cycle-number logic. The id lives in output_json instead.
  const outputJson = JSON.stringify({ raw_output: String(text || '').slice(0, 2000), cycle_id: cycleId ?? null });
  try {
    await query(
      `INSERT INTO agent_decisions
         (agent_name, agent_layer, model_used, input_tokens, output_tokens,
          cost_usd, output_json, source_system, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [agentName, layer, model, inputTokens, outputTokens, costUsd, outputJson, source]
    );
  } catch (err) {
    if (err.code === '42703') {
      try {
        await query(
          `INSERT INTO agent_decisions
             (agent_name, agent_layer, model_used, input_tokens, output_tokens, cost_usd, output_json, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
          [agentName, layer, model, inputTokens, outputTokens, costUsd, outputJson]
        );
      } catch (err2) {
        console.warn(`[${agentName}] agent_decisions log failed (non-critical):`, err2.message);
      }
    } else {
      console.warn(`[${agentName}] agent_decisions log failed (non-critical):`, err.message);
    }
  }
}

module.exports = {
  callClaude,
  extractJson,
  recoverArrays,
  stripFences,
  isRetryable,
  parseRetryAfterMs,
  backoffMs,
  batchDelayMs,
  waitBetweenBatches,
  logForeignDecision,
  MAX_ATTEMPTS,
  _setClient,
  _setSleep,
};
