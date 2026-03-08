const { queryAll, queryOne, query } = require('../../../db/connection');
const { notify, TIERS } = require('../../../services/notifications');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/notifications/config — get all notification configs
  fastify.get('/notifications/config', async () => {
    const configs = await queryAll('SELECT * FROM notification_config ORDER BY tier, channel');
    return { configs, tiers: TIERS };
  });

  // POST /api/notifications/config — create/update notification config
  fastify.post('/notifications/config', async (request, reply) => {
    const { channel, tier, config, enabled } = request.body;
    if (!['webhook'].includes(channel)) {
      return reply.code(400).send({ error: 'Supported channels: webhook' });
    }
    if (!TIERS[tier]) {
      return reply.code(400).send({ error: `Invalid tier. Use: ${Object.keys(TIERS).join(', ')}` });
    }

    const result = await queryOne(`
      INSERT INTO notification_config (channel, tier, config, enabled)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [channel, tier, JSON.stringify(config), enabled !== false]);
    return reply.code(201).send(result);
  });

  // PATCH /api/notifications/config/:id — toggle enabled
  fastify.patch('/notifications/config/:id', async (request) => {
    const { enabled } = request.body;
    return queryOne('UPDATE notification_config SET enabled = $2 WHERE id = $1 RETURNING *', [request.params.id, enabled]);
  });

  // DELETE /api/notifications/config/:id — remove config
  fastify.delete('/notifications/config/:id', async (request, reply) => {
    await query('DELETE FROM notification_config WHERE id = $1', [request.params.id]);
    return reply.code(204).send();
  });

  // GET /api/notifications/log — recent notification history
  fastify.get('/notifications/log', async (request) => {
    const { limit, tier } = request.query;
    if (tier) {
      return queryAll('SELECT * FROM notification_log WHERE tier = $1 ORDER BY created_at DESC LIMIT $2', [tier, parseInt(limit) || 50]);
    }
    return queryAll('SELECT * FROM notification_log ORDER BY created_at DESC LIMIT $1', [parseInt(limit) || 50]);
  });

  // POST /api/notifications/test — send a test notification
  fastify.post('/notifications/test', async (request) => {
    const { tier } = request.body || {};
    const results = await notify(tier || 'info', 'GRID Test Notification', 'This is a test notification from GRID.');
    return { results };
  });
}

module.exports = routes;
