require('dotenv').config();
const path = require('path');
const fastify = require('fastify')({ logger: true });
const { migrate } = require('./db/migrate');
const logger = require('./services/logger');

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

  // Public healthcheck (no auth — used by Railway)
  fastify.get('/api/system/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  // Live prices from exchange (no auth — used for real-time display)
  const { queryOne: queryOnePriceLive } = require('./db/connection');
  fastify.get('/api/prices/live', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const results = await Promise.all(
      CANDLE_SYMBOLS.map(async (symbol) => {
        const result = await fetchLivePrice(symbol);
        if (!result) return null;
        // Use CoinGecko's 24h change if available, otherwise compute from DB
        let change24h = result.change24h ?? null;
        if (change24h == null) {
          try {
            const old24h = await queryOnePriceLive(
              `SELECT close FROM market_data WHERE symbol = $1 AND timestamp <= NOW() - interval '24 hours' ORDER BY timestamp DESC LIMIT 1`,
              [symbol]
            );
            const oldPrice = old24h ? parseFloat(old24h.close) : null;
            change24h = oldPrice && oldPrice > 0 ? ((result.price - oldPrice) / oldPrice) * 100 : null;
          } catch (err) {
            logger.debug('24h price change query failed', { err, symbol, error_type: 'price_fallback' });
          }
        }
        return { symbol: result.dashSym, price: result.price, change24h };
      })
    );
    const prices = {};
    for (const r of results) {
      if (r) prices[r.symbol] = { price: r.price, change24h: r.change24h };
    }
    return prices;
  });

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

// ---------- Market Data ----------
const PYTHON_ENGINE_URL = process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100';
const CANDLE_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
const BINANCE_MAP = { 'BTC/USDT': 'BTCUSDT', 'ETH/USDT': 'ETHUSDT', 'SOL/USDT': 'SOLUSDT' };
const COINGECKO_MAP = { 'BTC/USDT': 'bitcoin', 'ETH/USDT': 'ethereum', 'SOL/USDT': 'solana' };

// Cached CoinGecko prices (fetched in batch, shared across symbols)
let coingeckoCache = { prices: {}, fetchedAt: 0 };

async function fetchCoinGeckoPrices() {
  if (Date.now() - coingeckoCache.fetchedAt < 20_000) return coingeckoCache.prices;
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',
      { signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = await res.json();
      coingeckoCache = { prices: data, fetchedAt: Date.now() };
      console.log('[PRICE] CoinGecko fetch OK');
      return data;
    }
  } catch (err) {
    console.error('[PRICE] CoinGecko failed:', err.message);
  }
  return coingeckoCache.prices;
}

async function fetchLivePrice(symbol) {
  const dashSym = symbol.replace('/', '-');

  // 1. Try Python engine
  try {
    const res = await fetch(`${PYTHON_ENGINE_URL}/price/${dashSym}`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      if (data.price) return { dashSym, price: data.price, source: 'engine' };
    }
  } catch (err) {
    logger.debug('Python engine price unavailable', { err, symbol, error_type: 'price_fallback' });
  }

  // 2. Try Binance
  try {
    const binanceSym = BINANCE_MAP[symbol];
    if (binanceSym) {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSym}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (data.price) return { dashSym, price: parseFloat(data.price), source: 'binance' };
      }
    }
  } catch (err) {
    logger.debug('Binance price unavailable', { err, symbol, error_type: 'price_fallback' });
  }

  // 3. Try CoinGecko
  try {
    const cgId = COINGECKO_MAP[symbol];
    if (cgId) {
      const cgData = await fetchCoinGeckoPrices();
      if (cgData[cgId]?.usd) {
        return { dashSym, price: cgData[cgId].usd, change24h: cgData[cgId].usd_24h_change, source: 'coingecko' };
      }
    }
  } catch (err) {
    logger.debug('CoinGecko price unavailable', { err, symbol, error_type: 'price_fallback' });
  }

  // 4. Latest DB candle
  try {
    const { queryOne: qo } = require('./db/connection');
    const row = await qo(`SELECT close FROM market_data WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`, [symbol]);
    if (row?.close) return { dashSym, price: parseFloat(row.close), source: 'db' };
  } catch (err) {
    logger.debug('DB candle fallback failed', { err, symbol, error_type: 'price_fallback' });
  }

  return null;
}

async function refreshCandles({ backfill = false } = {}) {
  for (const symbol of CANDLE_SYMBOLS) {
    for (const tf of ['5m', '1h', '4h']) {
      try {
        // On boot/backfill fetch 200 candles for 5m (covers ~16h), otherwise just 10 for incremental
        const limit = backfill ? 200 : 10;
        const res = await fetch(`${PYTHON_ENGINE_URL}/fetch-ohlcv`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, timeframe: tf, limit }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      } catch (err) {
        console.error(`[CANDLES] ${symbol} ${tf}:`, err.message);
      }
    }
  }
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

  // Monitor open positions + check standing orders every 15 minutes
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

    // Check standing order triggers
    try {
      await orchestrator.checkStandingOrders(broadcast);
    } catch (err) {
      console.error('[CRON] Standing order check failed:', err.message);
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

  // Hourly position review (independent of 4h cycle, runs at :30)
  cron.schedule('30 * * * *', async () => {
    console.log('[CRON] Running hourly position review...');
    try {
      const result = await orchestrator.reviewOpenPositions(0, broadcast);
      console.log(`[CRON] Position review: ${result.reviews.length} reviewed`);
    } catch (err) {
      console.error('[CRON] Hourly position review failed:', err.message);
    }
  });

  // Fetch external data every 30 minutes
  const { fetchAll } = require('./agents/external-data-fetcher');
  cron.schedule('*/30 * * * *', async () => {
    try { await fetchAll(); }
    catch (err) { console.error('[CRON] External data fetch failed:', err.message); }
  });

  // Fetch fresh candles every 5 minutes (keeps market_data current)
  cron.schedule('*/5 * * * *', async () => {
    try { await refreshCandles(); }
    catch (err) { console.error('[CRON] Candle refresh failed:', err.message); }
  });

  // Python engine health check every 5 minutes
  let pythonFailCount = 0;
  cron.schedule('*/5 * * * *', async () => {
    try {
      const res = await fetch(`${PYTHON_ENGINE_URL}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (pythonFailCount > 0) console.log('[HEALTH] Python engine recovered');
      pythonFailCount = 0;
    } catch (err) {
      pythonFailCount++;
      console.error(`[HEALTH] Python engine check failed (${pythonFailCount}/3): ${err.message}`);
      if (pythonFailCount >= 3) {
        console.error('[CRITICAL] Python engine unreachable — 3 consecutive failures');
        broadcast('scram_warning', {
          reason: 'Python engine unreachable',
          failures: pythonFailCount,
        });
      }
    }
  });

  // Broadcast live prices every 10 seconds
  const { queryOne: queryOnePrice } = require('./db/connection');

  setInterval(async () => {
    for (const symbol of CANDLE_SYMBOLS) {
      try {
        const result = await fetchLivePrice(symbol);
        if (!result) continue;

        const old24h = await queryOnePrice(
          `SELECT close FROM market_data WHERE symbol = $1 AND timestamp <= NOW() - interval '24 hours' ORDER BY timestamp DESC LIMIT 1`,
          [symbol]
        );
        const oldPrice = old24h ? parseFloat(old24h.close) : null;
        const change24h = oldPrice && oldPrice > 0 ? ((result.price - oldPrice) / oldPrice) * 100 : null;
        broadcast('price_update', { symbol: result.dashSym, price: result.price, change24h });
      } catch (err) {
        console.error(`[PRICE] ${symbol} broadcast failed:`, err.message);
      }
    }
  }, 10_000);
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

    // Fetch external data + fresh candles on boot
    const { fetchAll } = require('./agents/external-data-fetcher');
    fetchAll().catch(err => console.error('[BOOT] External data fetch failed:', err.message));
    refreshCandles({ backfill: true }).then(() => console.log('[BOOT] Candle refresh complete')).catch(err => console.error('[BOOT] Candle refresh failed:', err.message));

    // Listen
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[GRID] Server running on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
