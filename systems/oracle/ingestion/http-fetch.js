'use strict';

/**
 * Hardened HTTP GET for ORACLE ingestion feeds: https only, request timeout, bounded
 * redirects (each hop must also be https), bounded response size. Also tracks per-source
 * success/failure counts for the health endpoint.
 */

const https = require('https');

const DEFAULTS = {
  timeoutMs: parseInt(process.env.INGESTION_TIMEOUT_MS || '10000', 10),
  maxRedirects: 3,
  maxBytes: parseInt(process.env.INGESTION_MAX_BYTES || String(2 * 1024 * 1024), 10),
};

/**
 * @param {string} url  must be https://
 * @param {{timeoutMs?:number,maxRedirects?:number,maxBytes?:number,headers?:object}} [opts]
 * @returns {Promise<string>} response body (utf8)
 */
function fetchText(url, opts = {}, _redirects = 0) {
  const { timeoutMs, maxRedirects, maxBytes } = { ...DEFAULTS, ...opts };
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (_e) { return reject(new Error(`Invalid URL: ${String(url).slice(0, 100)}`)); }
    if (parsed.protocol !== 'https:') return reject(new Error(`Refusing non-https URL: ${parsed.protocol}//${parsed.host}`));

    const req = https.get(parsed, { headers: { 'User-Agent': 'GRID-ORACLE/1.0', ...(opts.headers || {}) } }, (res) => {
      const status = res.statusCode || 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (_redirects >= maxRedirects) return reject(new Error(`Too many redirects (>${maxRedirects})`));
        let next;
        try { next = new URL(res.headers.location, parsed).toString(); }
        catch (_e) { return reject(new Error('Invalid redirect location')); }
        return fetchText(next, opts, _redirects + 1).then(resolve, reject);
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${status} from ${parsed.host}`));
      }

      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error(`Response from ${parsed.host} exceeded ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Request to ${parsed.host} timed out after ${timeoutMs}ms`)); });
  });
}

// ── PER-SOURCE HEALTH COUNTERS (in-process; surfaced via ingestion heartbeat metadata) ──

const sourceStats = new Map(); // source -> {ok, failed, last_error, last_error_at, last_ok_at}

function recordSource(source, ok, error = null) {
  const s = sourceStats.get(source) || { ok: 0, failed: 0, last_error: null, last_error_at: null, last_ok_at: null };
  if (ok) { s.ok++; s.last_ok_at = new Date().toISOString(); }
  else {
    s.failed++;
    s.last_error = String(error?.message || error || 'unknown').slice(0, 200);
    s.last_error_at = new Date().toISOString();
    console.warn(`[INGESTION] source "${source}" failed: ${s.last_error}`);
  }
  sourceStats.set(source, s);
}

function getSourceStats() {
  return Object.fromEntries(sourceStats);
}

module.exports = { fetchText, recordSource, getSourceStats };
