const { queryAll, queryOne, query } = require('../db/connection');
const learningsDb = require('../db/queries/learnings');

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
      // total + by_stage
      queryOne(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE stage = 'candidate') as candidate,
          COUNT(*) FILTER (WHERE stage = 'provisional') as provisional,
          COUNT(*) FILTER (WHERE stage = 'active') as active,
          COUNT(*) FILTER (WHERE stage = 'decaying') as decaying,
          COUNT(*) FILTER (WHERE stage = 'invalidated') as invalidated
        FROM learnings
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
        FROM learnings WHERE stage = 'active'
      `),
      // learnings_this_week
      queryOne(`
        SELECT COUNT(*) as count FROM learnings
        WHERE created_at > NOW() - INTERVAL '7 days'
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
