// Platform Notifications API
const platformNotifications = require('../../shared/notifications');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/platform/notifications — recent notifications (optionally filtered by source or unread)
  fastify.get('/notifications', async (request) => {
    const { limit, source, unread } = request.query;
    if (unread === 'true') {
      return platformNotifications.getUnread();
    }
    return platformNotifications.getRecent({ limit: parseInt(limit) || 50, source });
  });

  // POST /api/platform/notifications/read-all — mark all as read
  fastify.post('/notifications/read-all', {
    schema: { body: { type: 'object', properties: {} } },
  }, async () => {
    return platformNotifications.markAllRead();
  });

  // POST /api/platform/notifications/:id/read — mark one as read
  fastify.post('/notifications/:id/read', {
    schema: { body: { type: 'object', properties: {} } },
  }, async (request, reply) => {
    const result = await platformNotifications.markRead(request.params.id);
    if (!result) return reply.code(404).send({ error: 'Notification not found' });
    return result;
  });
}

module.exports = routes;
