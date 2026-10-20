'use strict';

const { query, queryAll, queryOne } = require('../../../db/connection');
const bus = require('../../../shared/intelligence-bus');
const { sanitizeAssets } = require('../agents/validation');

// Max ACTIVE theses per domain. Beyond this the lowest-conviction, oldest-updated are retired.
const MAX_ACTIVE_PER_DOMAIN = Math.max(1, parseInt(process.env.ORACLE_MAX_ACTIVE_PER_DOMAIN || '8', 10) || 8);
// Name similarity (Jaccard on tokens) at/above which two same-direction, asset-overlapping theses are the same thesis.
const NAME_SIMILARITY_THRESHOLD = parseFloat(process.env.ORACLE_THESIS_NAME_SIMILARITY || '0.7');
const CONVICTION_UPDATE_DELTA = 0.3;

// ── DEDUPE KEYS (pure, exported for tests) ────────────────────────────────────

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'and', 'for', 'as', 'by', 'is', 'at']);

/** Lowercase, strip punctuation, drop stopwords, collapse spaces. */
function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(' ')
    .trim();
}

function primaryAssets(t) {
  return [...new Set([...(t.long_assets || []), ...(t.short_assets || [])].map((a) => String(a).toUpperCase()))].sort();
}

/** Stable key: normalised name | direction | sorted primary assets. */
function thesisKey(t) {
  return `${normaliseName(t.name)}|${t.direction || ''}|${primaryAssets(t).join(',')}`;
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Are two theses the same? Same direction AND (identical key OR similar name with overlapping
 * primary assets — or both without assets).
 */
function isSameThesis(a, b, threshold = NAME_SIMILARITY_THRESHOLD) {
  if (a.direction !== b.direction) return false;
  if (thesisKey(a) === thesisKey(b)) return true;
  const nameSim = jaccard(normaliseName(a.name).split(' '), normaliseName(b.name).split(' '));
  if (nameSim < threshold) return false;
  const pa = primaryAssets(a);
  const pb = primaryAssets(b);
  if (pa.length === 0 && pb.length === 0) return true;
  return pa.some((x) => pb.includes(x));
}

async function findExistingThesis(thesis) {
  const candidates = await queryAll(
    `SELECT id, thesis_id, name, direction, conviction, status, long_assets, short_assets
     FROM oracle_theses
     WHERE domain = $1 AND status != 'retired'`,
    [thesis.domain]
  );
  // Exact key match first, then similarity
  const exact = candidates.find((c) => thesisKey(c) === thesisKey(thesis));
  if (exact) return exact;
  return candidates.find((c) => isSameThesis(c, thesis)) || null;
}

/** Retire lowest-conviction / oldest active theses in the domain beyond the cap. */
async function enforceDomainCap(domain, keepThesisId) {
  const active = await queryAll(
    `SELECT thesis_id, conviction FROM oracle_theses
     WHERE domain = $1 AND status = 'active'
     ORDER BY conviction ASC, updated_at ASC`,
    [domain]
  );
  const excess = active.length - MAX_ACTIVE_PER_DOMAIN;
  if (excess <= 0) return 0;
  let retired = 0;
  for (const t of active) {
    if (retired >= excess) break;
    if (t.thesis_id === keepThesisId) continue;
    await retireThesis(t.thesis_id, `domain cap (${MAX_ACTIVE_PER_DOMAIN} active) — lowest conviction retired`);
    retired++;
  }
  if (retired > 0) console.warn(`[THESES] Domain "${domain}" over cap: retired ${retired} lowest-conviction thesis(es)`);
  return retired;
}

function busPayload(thesis, thesisId) {
  return {
    thesis_id:    thesisId,
    name:         thesis.name,
    domain:       thesis.domain,
    summary:      thesis.summary,
    catalyst:     thesis.catalyst,
    invalidation: thesis.invalidation,
  };
}

/**
 * Upsert a thesis into oracle_theses (the source of truth; the bus is notification only).
 * Existing = same domain + same normalised key, or similar name with overlapping assets.
 * Assets are stored as canonical tickers ('BTC', not 'BTC/USDT').
 */
async function upsertThesis(rawThesis) {
  const thesis = {
    ...rawThesis,
    long_assets:  sanitizeAssets(rawThesis.long_assets),
    short_assets: sanitizeAssets(rawThesis.short_assets),
    watch_assets: sanitizeAssets(rawThesis.watch_assets),
  };

  const existing = await findExistingThesis(thesis);

  if (existing) {
    const oldConviction = parseFloat(existing.conviction);
    const delta = Math.abs(thesis.conviction - oldConviction);
    const significant = delta >= CONVICTION_UPDATE_DELTA;

    if (significant) {
      await query(
        `UPDATE oracle_theses
         SET conviction = $1, summary = $3, catalyst = $4,
             invalidation = $5, long_assets = $6, short_assets = $7,
             watch_assets = $8, competing_view = COALESCE($9, competing_view),
             time_horizon = $10, updated_at = NOW()
         WHERE thesis_id = $2`,
        [
          thesis.conviction, existing.thesis_id,
          thesis.summary, thesis.catalyst || null, thesis.invalidation || null,
          thesis.long_assets, thesis.short_assets, thesis.watch_assets,
          thesis.competing_view || null, thesis.time_horizon,
        ]
      );

      await query(
        `INSERT INTO oracle_conviction_history
           (thesis_id, old_conviction, new_conviction, reason, triggered_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [existing.thesis_id, existing.conviction, thesis.conviction, 'Agent cycle revision', 'agent_cycle']
      );

      // Notification only — consumers read oracle_theses, so a failed publish loses nothing.
      try {
        const oldBusEvent = await queryOne('SELECT bus_event_id FROM oracle_theses WHERE thesis_id = $1', [existing.thesis_id]);
        const newBusResult = await bus.publish({
          source_system:   'oracle',
          event_type:      'thesis_created',
          payload:         busPayload(thesis, existing.thesis_id),
          conviction:      thesis.conviction,
          affected_assets: [...thesis.long_assets, ...thesis.short_assets],
          direction:       thesis.direction,
          time_horizon:    thesis.time_horizon,
          supersedes:      oldBusEvent?.bus_event_id || undefined,
        });
        if (newBusResult?.id) {
          await query('UPDATE oracle_theses SET bus_event_id = $1 WHERE thesis_id = $2', [newBusResult.id, existing.thesis_id]);
        }
        console.log(`[THESES] Updated conviction for "${thesis.name}": ${existing.conviction} → ${thesis.conviction}`);
      } catch (err) {
        console.error('[THESES] Bus publish failed (notification only):', err.message);
      }
    } else {
      // Thesis re-confirmed this cycle: touch updated_at so staleness can be judged by recency
      await query('UPDATE oracle_theses SET updated_at = NOW() WHERE thesis_id = $1', [existing.thesis_id]);
    }
    return { action: significant ? 'updated' : 'confirmed', thesis_id: existing.thesis_id };
  }

  // New thesis — upsert (ON CONFLICT updates if thesis_id already exists)
  const result = await query(
    `INSERT INTO oracle_theses
       (thesis_id, name, domain, direction, conviction, time_horizon,
        summary, catalyst, invalidation, competing_view,
        long_assets, short_assets, watch_assets, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active')
     ON CONFLICT (thesis_id) DO UPDATE SET
        name = EXCLUDED.name, domain = EXCLUDED.domain, direction = EXCLUDED.direction,
        conviction = EXCLUDED.conviction, time_horizon = EXCLUDED.time_horizon,
        summary = EXCLUDED.summary, catalyst = EXCLUDED.catalyst,
        invalidation = EXCLUDED.invalidation, competing_view = EXCLUDED.competing_view,
        long_assets = EXCLUDED.long_assets, short_assets = EXCLUDED.short_assets,
        watch_assets = EXCLUDED.watch_assets, updated_at = NOW()
     RETURNING id, thesis_id`,
    [
      thesis.thesis_id, thesis.name, thesis.domain, thesis.direction,
      thesis.conviction, thesis.time_horizon, thesis.summary,
      thesis.catalyst || null, thesis.invalidation || null,
      thesis.competing_view || null,
      thesis.long_assets, thesis.short_assets, thesis.watch_assets,
    ]
  );

  const saved = result.rows[0];

  // Notification only: oracle_theses is the source of truth, so bus expiry cannot lose the thesis.
  try {
    const busResult = await bus.publish({
      source_system:   'oracle',
      event_type:      'thesis_created',
      payload:         busPayload(thesis, saved.thesis_id),
      conviction:      thesis.conviction,
      affected_assets: [...thesis.long_assets, ...thesis.short_assets],
      direction:       thesis.direction,
      time_horizon:    thesis.time_horizon,
      dedupe_key:      `oracle:thesis_created:${saved.thesis_id}`,
    });

    const busId = busResult?.id;
    await query('UPDATE oracle_theses SET bus_event_id = $1 WHERE thesis_id = $2', [busId, saved.thesis_id]);
    console.log(`[THESES] New thesis created: "${thesis.name}" (${thesis.direction}, ${thesis.conviction}/10, bus:${busId})`);
  } catch (err) {
    console.error('[THESES] Bus publish failed for new thesis (notification only):', err.message);
  }

  try {
    await enforceDomainCap(thesis.domain, saved.thesis_id);
  } catch (err) {
    console.error('[THESES] Domain cap enforcement failed:', err.message);
  }

  return { action: 'created', thesis_id: saved.thesis_id };
}

async function getActiveTheses() {
  return queryAll(
    `SELECT * FROM oracle_theses
     WHERE status = 'active'
     ORDER BY conviction DESC`
  );
}

async function getThesisById(thesisId) {
  return queryOne(
    'SELECT * FROM oracle_theses WHERE thesis_id = $1',
    [thesisId]
  );
}

async function retireThesis(thesisId, reason) {
  await query(
    `UPDATE oracle_theses
     SET status = 'retired', retired_at = NOW(), updated_at = NOW()
     WHERE thesis_id = $1`,
    [thesisId]
  );

  try {
    await bus.publish({
      source_system: 'oracle',
      event_type:    'thesis_retired',
      payload:       { thesis_id: thesisId, reason },
    });
  } catch (err) {
    console.error(`[THESES] Bus publish for retirement of ${thesisId} failed (notification only):`, err.message);
  }
}

module.exports = {
  upsertThesis, getActiveTheses, getThesisById, retireThesis,
  // exported for tests / reuse
  thesisKey, normaliseName, isSameThesis, enforceDomainCap,
  MAX_ACTIVE_PER_DOMAIN,
};
