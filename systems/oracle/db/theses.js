'use strict';

const { query, queryAll, queryOne } = require('../../../db/connection');
const bus = require('../../../shared/intelligence-bus');

/**
 * Upsert a thesis into oracle_theses.
 * If a thesis with the same name already exists, update its conviction.
 * If new, insert and publish thesis_created to bus.
 */
async function upsertThesis(thesis) {
  // Check for existing thesis with same name (deduplication by name)
  const existing = await queryOne(
    `SELECT id, thesis_id, conviction, status
     FROM oracle_theses
     WHERE name = $1 AND status != 'retired'`,
    [thesis.name]
  );

  if (existing) {
    // Update conviction if changed significantly (>0.3 delta)
    const delta = Math.abs(thesis.conviction - parseFloat(existing.conviction));
    if (delta >= 0.3) {
      await query(
        `UPDATE oracle_theses
         SET conviction = $1, summary = $3, catalyst = $4,
             invalidation = $5, long_assets = $6, short_assets = $7,
             watch_assets = $8, updated_at = NOW()
         WHERE thesis_id = $2`,
        [
          thesis.conviction, existing.thesis_id,
          thesis.summary, thesis.catalyst || null, thesis.invalidation || null,
          thesis.long_assets, thesis.short_assets, thesis.watch_assets,
        ]
      );

      // Record conviction history
      await query(
        `INSERT INTO oracle_conviction_history
           (thesis_id, old_conviction, new_conviction, reason, triggered_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          existing.thesis_id,
          existing.conviction,
          thesis.conviction,
          'Agent cycle revision',
          'agent_cycle',
        ]
      );

      // Publish update to bus
      try {
        await bus.publish({
          source_system: 'oracle',
          event_type:    'thesis_conviction_updated',
          payload: {
            thesis_id:      existing.thesis_id,
            name:           thesis.name,
            old_conviction: parseFloat(existing.conviction),
            new_conviction: thesis.conviction,
          },
          conviction:      thesis.conviction,
          affected_assets: [...thesis.long_assets, ...thesis.short_assets],
          direction:       thesis.direction,
          time_horizon:    thesis.time_horizon,
        });
        console.log(`[THESES] Updated conviction for "${thesis.name}": ${existing.conviction} → ${thesis.conviction}`);
      } catch (err) {
        console.error('[THESES] Bus publish failed:', err.message);
      }
    }
    return { action: 'updated', thesis_id: existing.thesis_id };
  }

  // New thesis — insert
  const result = await query(
    `INSERT INTO oracle_theses
       (thesis_id, name, domain, direction, conviction, time_horizon,
        summary, catalyst, invalidation, competing_view,
        long_assets, short_assets, watch_assets, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active')
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

  // Publish to bus
  try {
    const busId = await bus.publish({
      source_system:   'oracle',
      event_type:      'thesis_created',
      payload: {
        thesis_id:   saved.thesis_id,
        name:        thesis.name,
        domain:      thesis.domain,
        summary:     thesis.summary,
        catalyst:    thesis.catalyst,
        invalidation: thesis.invalidation,
      },
      conviction:      thesis.conviction,
      affected_assets: [...thesis.long_assets, ...thesis.short_assets],
      direction:       thesis.direction,
      time_horizon:    thesis.time_horizon,
      // Theses never expire — they are retired explicitly
      expires_at:      null,
    });

    // Store bus event ID on thesis
    await query(
      'UPDATE oracle_theses SET bus_event_id = $1 WHERE thesis_id = $2',
      [busId, saved.thesis_id]
    );

    console.log(`[THESES] New thesis created: "${thesis.name}" (${thesis.direction}, ${thesis.conviction}/10, bus:${busId})`);
  } catch (err) {
    console.error('[THESES] Bus publish failed for new thesis:', err.message);
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
  } catch {}
}

module.exports = { upsertThesis, getActiveTheses, getThesisById, retireThesis };
