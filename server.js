require('dotenv').config();
const path = require('path');
const fastify = require('fastify')({ logger: true });
const { migrate } = require('./db/migrate');

const PORT = process.env.PORT || 3100;

// ---------- Plugins ----------
async function registerPlugins() {
  await fastify.register(require('@fastify/cors'), {
    origin: true,
    credentials: true,
  });

  await fastify.register(require('@fastify/cookie'));

  // Serve React build in production, fallback to public/
  const fs = require('fs');
  const distPath = path.join(__dirname, 'frontend', 'dist');
  const staticRoot = fs.existsSync(distPath) ? distPath : path.join(__dirname, 'public');
  await fastify.register(require('@fastify/static'), {
    root: staticRoot,
    prefix: '/',
  });

  await fastify.register(require('@fastify/websocket'));
}

// ---------- Auth Decorator ----------
const jwt = require('jsonwebtoken');

async function verifyToken(request, reply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing token' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    request.user = payload;
  } catch {
    return reply.code(401).send({ error: 'Invalid token' });
  }
}

fastify.decorate('authenticate', verifyToken);

// ---------- WebSocket ----------
const wsClients = new Set();

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ---------- Routes ----------
async function registerRoutes() {
  // Auth routes (no auth required)
  fastify.register(require('./api/auth'), { prefix: '/api/auth' });

  // Protected API routes
  fastify.register(require('./api/portfolio'), { prefix: '/api' });
  fastify.register(require('./api/trades'), { prefix: '/api' });
  fastify.register(require('./api/agents'), { prefix: '/api' });
  fastify.register(require('./api/market-data'), { prefix: '/api' });
  fastify.register(require('./api/signals'), { prefix: '/api' });
  fastify.register(require('./api/templates'), { prefix: '/api' });
  fastify.register(require('./api/learnings'), { prefix: '/api' });
  fastify.register(require('./api/costs'), { prefix: '/api' });
  fastify.register(require('./api/system'), { prefix: '/api' });
  fastify.register(require('./api/analytics'), { prefix: '/api' });
  fastify.register(require('./api/notifications'), { prefix: '/api' });
  fastify.register(require('./api/standing-orders'), { prefix: '/api' });
  fastify.register(require('./api/events'), { prefix: '/api' });

  // WebSocket endpoint
  fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket) => {
      wsClients.add(socket);
      socket.on('close', () => wsClients.delete(socket));
    });
  });

  // SPA fallback — serve index.html for non-API, non-file routes
  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
}

// ---------- Cron ----------
const cron = require('node-cron');

function setupCron() {
  const orchestrator = require('./agents/orchestrator');

  // 4-hour agent cycle
  cron.schedule('0 */4 * * *', async () => {
    console.log('[CRON] Starting agent cycle...');
    try {
      await orchestrator.runCycle({ broadcast });
    } catch (err) {
      console.error('[CRON] Agent cycle failed:', err.message);
    }
  });

  // Monitor open positions every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    console.log('[CRON] Monitoring positions...');
    try {
      const result = await orchestrator.monitorPositions();
      const closed = result?.closed || [];
      if (closed.length > 0) {
        console.log(`[CRON] ${closed.length} position(s) closed by monitor`);
        broadcast('positions_closed', { closed });
      }
    } catch (err) {
      console.error('[CRON] Position monitor failed:', err.message);
    }
  });

  // Clean expired signals every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const signalsDb = require('./db/queries/signals');
      await signalsDb.cleanExpired();
      console.log('[CRON] Cleaned expired signals');
    } catch (err) {
      console.error('[CRON] Signal cleanup failed:', err.message);
    }
  });

  // Fetch external data every 30 minutes
  const { fetchAll } = require('./agents/external-data-fetcher');
  cron.schedule('*/30 * * * *', async () => {
    try { await fetchAll(); }
    catch (err) { console.error('[CRON] External data fetch failed:', err.message); }
  });
}

// ---------- Boot ----------
async function start() {
  try {
    // Run migrations
    await migrate();

    // Register plugins & routes
    await registerPlugins();
    await registerRoutes();

    // Make broadcast available to route handlers
    fastify.decorate('broadcast', broadcast);

    // Start cron
    setupCron();

    // Fetch external data on boot
    const { fetchAll } = require('./agents/external-data-fetcher');
    fetchAll().catch(err => console.error('[BOOT] External data fetch failed:', err.message));

    // Listen
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[GRID] Server running on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
