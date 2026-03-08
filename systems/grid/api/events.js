const { queryAll, queryOne, query } = require('../../../db/connection');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/events — upcoming events
  fastify.get('/events', async (request) => {
    const { limit, past } = request.query;
    if (past === 'true') {
      return queryAll('SELECT * FROM events_calendar ORDER BY event_date DESC LIMIT $1', [parseInt(limit) || 30]);
    }
    return queryAll(`
      SELECT * FROM events_calendar
      WHERE event_date > NOW() - INTERVAL '1 day'
      ORDER BY event_date ASC
      LIMIT $1
    `, [parseInt(limit) || 30]);
  });

  // GET /api/events/blackout — check if currently in a blackout zone
  fastify.get('/events/blackout', async () => {
    const active = await queryAll(`
      SELECT * FROM events_calendar
      WHERE blackout_start <= NOW() AND blackout_end >= NOW()
      ORDER BY event_date ASC
    `);
    return {
      in_blackout: active.length > 0,
      events: active,
    };
  });

  // POST /api/events — create event
  fastify.post('/events', async (request, reply) => {
    const { event_type, event_name, event_date, impact_estimate, affected_assets, notes, blackout_hours } = request.body;

    if (!event_type || !event_name || !event_date) {
      return reply.code(400).send({ error: 'event_type, event_name, and event_date are required' });
    }

    const bh = blackout_hours || (impact_estimate === 'critical' ? 4 : impact_estimate === 'high' ? 2 : 1);
    const eventDateObj = new Date(event_date);
    const blackoutStart = new Date(eventDateObj.getTime() - bh * 3600 * 1000).toISOString();
    const blackoutEnd = new Date(eventDateObj.getTime() + bh * 3600 * 1000).toISOString();

    const result = await queryOne(`
      INSERT INTO events_calendar (event_type, event_name, event_date, impact_estimate, affected_assets, notes, blackout_start, blackout_end)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [event_type, event_name, event_date, impact_estimate || 'medium',
      JSON.stringify(affected_assets || []), notes || '', blackoutStart, blackoutEnd]);

    return reply.code(201).send(result);
  });

  // DELETE /api/events/:id — remove event
  fastify.delete('/events/:id', async (request, reply) => {
    await query('DELETE FROM events_calendar WHERE id = $1', [request.params.id]);
    return reply.code(204).send();
  });
}

module.exports = routes;
