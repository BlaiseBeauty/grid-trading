const { queryAll, queryOne, query } = require('../../../db/connection');
const learningsDb = require('../../../db/queries/learnings');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ─────────────────────────────────────
  // GET /api/learnings
  // ─────────────────────────────────────
  fastify.get('/learnings', async (request) => {
    const { stage, learning_type, scope_level } = request.query;
    const conditions = ['l.invalidated_at IS NULL'];
    const params = [];

    if (stage) {
      params.push(stage);
      conditions.push(`l.stage = $${params.length}`);
    }
    if (learning_type) {
      params.push(learning_type);
      conditions.push(`l.learning_type = $${params.length}`);
    }
    if (scope_level) {
      params.push(scope_level);
      conditions.push(`l.scope_level = $${params.length}`);
    }

    return queryAll(`
      SELECT l.*,
        CASE WHEN l.influenced_trades > 0
          THEN ROUND(l.influenced_wins::numeric /
               l.influenced_trades * 100, 1)
          ELSE NULL END as win_rate_pct,
        (
          SELECT COUNT(*) FROM learning_conflicts lc
          WHERE (lc.learning_a_id = l.id OR lc.learning_b_id = l.id)
            AND lc.resolved_at IS NULL
        ) as unresolved_conflicts
      FROM learnings l
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE l.stage
          WHEN 'active' THEN 1
          WHEN 'provisional' THEN 2
          WHEN 'candidate' THEN 3
          WHEN 'decaying' THEN 4
        END,
        l.decayed_confidence DESC NULLS LAST
    `, params);
  });

  // ─────────────────────────────────────
  // GET /api/learnings/stats
  // ─────────────────────────────────────
  fastify.get('/learnings/stats', async () => {
    const [totals, byType, byScope, conflictsRow, mostEffective,
           mostReferenced, avgConf, thisWeek, knowledgeWr] = await Promise.all([
      // total + by_stage — live learnings only (matches pipeline WHERE invalidated_at IS NULL)
      queryOne(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE stage = 'candidate') as candidate,
          COUNT(*) FILTER (WHERE stage = 'provisional') as provisional,
          COUNT(*) FILTER (WHERE stage = 'active') as active,
          COUNT(*) FILTER (WHERE stage = 'decaying') as decaying,
          COUNT(*) FILTER (WHERE stage = 'invalidated') as invalidated
        FROM learnings
        WHERE invalidated_at IS NULL
      `),
      // by_type
      queryAll(`
        SELECT learning_type, COUNT(*) as count
        FROM learnings WHERE invalidated_at IS NULL
        GROUP BY learning_type ORDER BY count DESC
      `),
      // by_scope
      queryAll(`
        SELECT scope_level, COUNT(*) as count
        FROM learnings WHERE invalidated_at IS NULL
        GROUP BY scope_level ORDER BY count DESC
      `),
      // conflicts_unresolved
      queryOne(`
        SELECT COUNT(*) as count FROM learning_conflicts WHERE resolved_at IS NULL
      `),
      // most_effective: top 5 by win_rate WHERE influenced_trades >= 3
      queryAll(`
        SELECT id, insight_text, influenced_trades, influenced_wins, stage,
          ROUND(influenced_wins::numeric / influenced_trades * 100, 1) as win_rate_pct
        FROM learnings
        WHERE influenced_trades >= 3 AND invalidated_at IS NULL
        ORDER BY influenced_wins::numeric / influenced_trades DESC
        LIMIT 5
      `),
      // most_referenced: top 5 by times_referenced
      queryAll(`
        SELECT id, insight_text, times_referenced, stage, decayed_confidence
        FROM learnings
        WHERE invalidated_at IS NULL
        ORDER BY times_referenced DESC
        LIMIT 5
      `),
      // avg_decayed_confidence of active learnings
      queryOne(`
        SELECT ROUND(AVG(decayed_confidence)::numeric, 3) as avg
        FROM learnings WHERE stage = 'active' AND invalidated_at IS NULL
      `),
      // learnings_this_week
      queryOne(`
        SELECT COUNT(*) as count FROM learnings
        WHERE created_at > NOW() - INTERVAL '7 days' AND invalidated_at IS NULL
      `),
      // knowledge_win_rate
      queryOne(`
        SELECT
          COALESCE(SUM(influenced_wins), 0) as total_wins,
          COALESCE(SUM(influenced_trades), 0) as total_trades
        FROM learnings WHERE invalidated_at IS NULL
      `),
    ]);

    return {
      total: parseInt(totals.total),
      by_stage: {
        candidate: parseInt(totals.candidate),
        provisional: parseInt(totals.provisional),
        active: parseInt(totals.active),
        decaying: parseInt(totals.decaying),
        invalidated: parseInt(totals.invalidated),
      },
      by_type: byType,
      by_scope: byScope,
      conflicts_unresolved: parseInt(conflictsRow.count),
      most_effective: mostEffective,
      most_referenced: mostReferenced,
      avg_decayed_confidence: avgConf.avg ? parseFloat(avgConf.avg) : null,
      learnings_this_week: parseInt(thisWeek.count),
      knowledge_win_rate: parseInt(knowledgeWr.total_trades) > 0
        ? Math.round(parseInt(knowledgeWr.total_wins) / parseInt(knowledgeWr.total_trades) * 1000) / 10
        : null,
    };
  });

  // ─────────────────────────────────────
  // GET /api/learnings/:id/influence
  // ─────────────────────────────────────
  fastify.get('/learnings/:id/influence', async (request, reply) => {
    const { id } = request.params;

    const learning = await queryOne(`SELECT * FROM learnings WHERE id = $1`, [id]);
    if (!learning) return reply.code(404).send({ error: 'Learning not found' });

    const [events, conflicts] = await Promise.all([
      queryAll(`
        SELECT * FROM learning_influence_events
        WHERE learning_id = $1
        ORDER BY created_at DESC
        LIMIT 50
      `, [id]),
      queryAll(`
        SELECT lc.*,
          la.insight_text as learning_a_text,
          la.learning_type as learning_a_type,
          la.decayed_confidence as learning_a_confidence,
          lb.insight_text as learning_b_text,
          lb.learning_type as learning_b_type,
          lb.decayed_confidence as learning_b_confidence
        FROM learning_conflicts lc
        JOIN learnings la ON la.id = lc.learning_a_id
        JOIN learnings lb ON lb.id = lc.learning_b_id
        WHERE lc.learning_a_id = $1 OR lc.learning_b_id = $1
        ORDER BY lc.detected_at DESC
      `, [id]),
    ]);

    return {
      learning,
      events,
      regime_breakdown: learning.regime_breakdown || {},
      conflicts,
    };
  });

  // ─────────────────────────────────────
  // GET /api/learnings/conflicts
  // ─────────────────────────────────────
  fastify.get('/learnings/conflicts', async () => {
    return queryAll(`
      SELECT lc.*,
        la.insight_text as learning_a_text,
        la.learning_type as learning_a_type,
        la.decayed_confidence as learning_a_confidence,
        lb.insight_text as learning_b_text,
        lb.learning_type as learning_b_type,
        lb.decayed_confidence as learning_b_confidence
      FROM learning_conflicts lc
      JOIN learnings la ON la.id = lc.learning_a_id
      JOIN learnings lb ON lb.id = lc.learning_b_id
      WHERE lc.resolved_at IS NULL
      ORDER BY lc.detected_at DESC
    `);
  });

  // ─────────────────────────────────────
  // POST /api/learnings/evaluate
  // Run stage promotion evaluation immediately (same logic as advanceLearningStages).
  // Bootstrap: < 100 closed trades → promote candidates with sample_size >= 3
  // Learned:  >= 100 closed trades → promote candidates with sample_size >= 5 AND win_rate >= 55%
  // ─────────────────────────────────────
  fastify.post('/learnings/evaluate', async () => {
    const CONF_MAP = { high: 0.85, med: 0.6, medium: 0.6, low: 0.3 };

    // 1. Recompute decayed_confidence
    const allLearnings = await queryAll(`
      SELECT id, confidence, confidence_halflife_days, last_validated_at
      FROM learnings WHERE invalidated_at IS NULL AND stage != 'invalidated'
    `);
    for (const l of allLearnings) {
      const baseConf = CONF_MAP[l.confidence] || 0.5;
      const daysSince = l.last_validated_at
        ? (Date.now() - new Date(l.last_validated_at).getTime()) / 86400000 : 0;
      const decayed = baseConf * Math.pow(0.5, daysSince / (l.confidence_halflife_days || 14));
      await queryOne(`UPDATE learnings SET decayed_confidence = $1 WHERE id = $2`,
        [Math.round(decayed * 1000) / 1000, l.id]);
    }

    // 2. candidate → provisional (bootstrap-aware)
    const totalTradesRow = await queryOne(`SELECT COUNT(*) as cnt FROM trades WHERE status = 'closed'`);
    const totalTrades = parseInt(totalTradesRow?.cnt || '0');
    const mode = totalTrades < 100 ? 'bootstrap' : 'learned';

    let promotedToProvisional;
    if (totalTrades < 100) {
      const r = await query(`
        UPDATE learnings SET stage = 'provisional', last_validated_at = NOW()
        WHERE stage = 'candidate' AND sample_size >= 3
      `);
      promotedToProvisional = r.rowCount;
    } else {
      const r = await query(`
        UPDATE learnings SET stage = 'provisional', last_validated_at = NOW()
        WHERE stage = 'candidate'
          AND sample_size >= 5
          AND influenced_wins::float / NULLIF(influenced_trades, 0) >= 0.55
      `);
      promotedToProvisional = r.rowCount;
    }

    // 3. provisional → active (2+ distinct regimes)
    const r2 = await query(`
      UPDATE learnings SET stage = 'active', last_validated_at = NOW()
      WHERE stage = 'provisional'
        AND (SELECT COUNT(DISTINCT key) FROM jsonb_each(COALESCE(regime_breakdown, '{}'))) >= 2
    `);

    // 4. active → decaying
    const r3 = await query(`
      UPDATE learnings SET stage = 'decaying'
      WHERE stage = 'active'
        AND (
          decayed_confidence < 0.4
          OR (influenced_trades >= 5 AND influenced_wins::float / NULLIF(influenced_trades, 0) < 0.45)
        )
    `);

    // 5. decaying → invalidated
    const r4 = await query(`
      UPDATE learnings SET stage = 'invalidated', invalidated_at = NOW(),
        invalidation_reason = 'auto: win_rate < 35% over 10+ trades'
      WHERE stage = 'decaying'
        AND influenced_trades >= 10
        AND influenced_wins::float / NULLIF(influenced_trades, 0) < 0.35
    `);

    // Final stage counts — live learnings only (matches pipeline filter)
    const counts = await queryOne(`
      SELECT
        COUNT(*) FILTER (WHERE stage = 'candidate')    as candidate,
        COUNT(*) FILTER (WHERE stage = 'provisional')  as provisional,
        COUNT(*) FILTER (WHERE stage = 'active')       as active,
        COUNT(*) FILTER (WHERE stage = 'decaying')     as decaying,
        COUNT(*) FILTER (WHERE stage = 'invalidated')  as invalidated
      FROM learnings
      WHERE invalidated_at IS NULL
    `);

    return {
      total_closed_trades: totalTrades,
      threshold_mode: mode,
      promoted_to_provisional: promotedToProvisional,
      promoted_to_active: r2.rowCount,
      sent_to_decaying: r3.rowCount,
      invalidated: r4.rowCount,
      stage_counts: {
        candidate:   parseInt(counts.candidate),
        provisional: parseInt(counts.provisional),
        active:      parseInt(counts.active),
        decaying:    parseInt(counts.decaying),
        invalidated: parseInt(counts.invalidated),
      },
    };
  });

  // ─────────────────────────────────────
  // PATCH /api/learnings/:id
  // ─────────────────────────────────────
  fastify.patch('/learnings/:id', async (request, reply) => {
    const { id } = request.params;
    const { stage, invalidation_reason } = request.body || {};

    const existing = await queryOne(`SELECT * FROM learnings WHERE id = $1`, [id]);
    if (!existing) return reply.code(404).send({ error: 'Learning not found' });

    const sets = [];
    const params = [id];

    if (stage) {
      params.push(stage);
      sets.push(`stage = $${params.length}`);
      if (stage === 'invalidated') {
        sets.push(`invalidated_at = NOW()`);
      }
    }
    if (invalidation_reason) {
      params.push(invalidation_reason);
      sets.push(`invalidation_reason = $${params.length}`);
    }

    if (sets.length === 0) {
      return reply.code(400).send({ error: 'No valid fields to update' });
    }

    const updated = await queryOne(`
      UPDATE learnings SET ${sets.join(', ')}
      WHERE id = $1
      RETURNING *
    `, params);

    return updated;
  });

  // ─────────────────────────────────────
  // POST /api/learnings/conflicts/:id/resolve
  // ─────────────────────────────────────
  fastify.post('/learnings/conflicts/:id/resolve', async (request, reply) => {
    const { id } = request.params;
    const { resolution } = request.body || {};

    const validResolutions = ['kept_a', 'kept_b', 'merged', 'regime_dependent'];
    if (!resolution || !validResolutions.includes(resolution)) {
      return reply.code(400).send({
        error: `resolution must be one of: ${validResolutions.join(', ')}`,
      });
    }

    const conflict = await queryOne(`
      SELECT * FROM learning_conflicts WHERE id = $1
    `, [id]);
    if (!conflict) return reply.code(404).send({ error: 'Conflict not found' });
    if (conflict.resolved_at) return reply.code(400).send({ error: 'Conflict already resolved' });

    // Resolve the conflict
    const updated = await queryOne(`
      UPDATE learning_conflicts
      SET resolved_at = NOW(), resolution = $2, resolved_by = 'operator'
      WHERE id = $1
      RETURNING *
    `, [id, resolution]);

    // Invalidate the losing learning
    if (resolution === 'kept_a') {
      await query(`
        UPDATE learnings
        SET stage = 'invalidated', invalidated_at = NOW(),
            invalidation_reason = 'conflict_resolved: kept_a',
            superseded_by = $2
        WHERE id = $1
      `, [conflict.learning_b_id, conflict.learning_a_id]);
    } else if (resolution === 'kept_b') {
      await query(`
        UPDATE learnings
        SET stage = 'invalidated', invalidated_at = NOW(),
            invalidation_reason = 'conflict_resolved: kept_b',
            superseded_by = $2
        WHERE id = $1
      `, [conflict.learning_a_id, conflict.learning_b_id]);
    }

    return updated;
  });
}

module.exports = routes;
