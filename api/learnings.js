const learningsDb = require('../db/queries/learnings');
const { queryAll } = require('../db/connection');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/learnings', async (request) => {
    return learningsDb.getActive({
      category: request.query.category,
      limit: parseInt(request.query.limit) || 100,
    });
  });

  fastify.get('/learnings/:id', async (request, reply) => {
    const learning = await learningsDb.getById(request.params.id);
    if (!learning) return reply.code(404).send({ error: 'Learning not found' });
    return learning;
  });

  // All learnings including invalidated
  fastify.get('/learnings/all', async (request) => {
    return queryAll(`
      SELECT * FROM learnings
      ORDER BY created_at DESC
      LIMIT $1
    `, [parseInt(request.query.limit) || 100]);
  });

  // Learnings by source agent
  fastify.get('/learnings/agent/:agent', async (request) => {
    return queryAll(`
      SELECT * FROM learnings
      WHERE source_agent = $1 AND invalidated_at IS NULL
      ORDER BY created_at DESC
      LIMIT $2
    `, [request.params.agent, parseInt(request.query.limit) || 50]);
  });

  // Learning categories summary
  fastify.get('/learnings/summary', async () => {
    return queryAll(`
      SELECT
        category,
        COUNT(*) FILTER (WHERE invalidated_at IS NULL) as active_count,
        COUNT(*) FILTER (WHERE invalidated_at IS NOT NULL) as invalidated_count,
        COUNT(*) FILTER (WHERE confidence = 'high') as high_confidence,
        COUNT(*) FILTER (WHERE confidence = 'med') as med_confidence,
        COUNT(*) FILTER (WHERE confidence = 'low') as low_confidence
      FROM learnings
      GROUP BY category
      ORDER BY active_count DESC
    `);
  });
}

module.exports = routes;
