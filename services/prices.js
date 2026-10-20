'use strict';

/**
 * Live price lookup, candle refresh and the Node.js stop-loss fallback.
 * Extracted from server.js (behaviour unchanged, plus a batched 24h-change lookup).
 */

const logger = require('./logger');
const { queryOne, queryAll } = require('../db/connection');
const { symbols: trackedSymbolsConfig } = require('../config/symbols');

const PYTHON_ENGINE_URL = process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:5100';
const CANDLE_SYMBOLS = trackedSymbolsConfig.map(s => s.symbol);
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

  // 2. Try CoinGecko (skip Binance — geo-blocked on Railway)
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

  // 3. Latest DB candle
  try {
    const row = await queryOne(`SELECT close FROM market_data WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`, [symbol]);
    if (row?.close) return { dashSym, price: parseFloat(row.close), source: 'db' };
  } catch (err) {
    logger.debug('DB candle fallback failed', { err, symbol, error_type: 'price_fallback' });
  }

  return null;
}

/**
 * One query for the close ~24h ago of many symbols (replaces a query per symbol).
 * Returns { [symbol]: number } — symbols without history are absent.
 */
async function getOldPrices24h(symbols) {
  if (!symbols.length) return {};
  const rows = await queryAll(
    `SELECT DISTINCT ON (symbol) symbol, close
       FROM market_data
      WHERE symbol = ANY($1) AND timestamp <= NOW() - interval '24 hours'
      ORDER BY symbol, timestamp DESC`,
    [symbols]
  );
  const out = {};
  for (const r of rows) out[r.symbol] = parseFloat(r.close);
  return out;
}

/**
 * Live price + 24h change for each symbol, with ONE DB lookup for the whole set.
 * Returns an array of { symbol, price, change24h } (symbol in dashed form, e.g. BTC-USDT).
 * CoinGecko's own 24h change wins when present; otherwise computed from the DB.
 */
async function getLivePricesWithChange(symbols = CANDLE_SYMBOLS) {
  const live = await Promise.all(symbols.map(async (symbol) => ({ symbol, result: await fetchLivePrice(symbol) })));
  const found = live.filter(l => l.result);

  const needDb = found.filter(l => l.result.change24h == null).map(l => l.symbol);
  let oldPrices = {};
  if (needDb.length) {
    try {
      oldPrices = await getOldPrices24h(needDb);
    } catch (err) {
      logger.debug('24h price change query failed', { err, error_type: 'price_fallback' });
    }
  }

  return found.map(({ symbol, result }) => {
    let change24h = result.change24h ?? null;
    if (change24h == null) {
      const oldPrice = oldPrices[symbol];
      change24h = oldPrice && oldPrice > 0 ? ((result.price - oldPrice) / oldPrice) * 100 : null;
    }
    return { symbol: result.dashSym, price: result.price, change24h };
  });
}

// Backwards-compatible alias used by server.js
const getChange24hBatch = getOldPrices24h;

/**
 * Node.js fallback for stop-loss enforcement when Python engine is unreachable.
 * Uses the same fetchLivePrice() chain (Python → CoinGecko → DB candle).
 */
async function checkStopLossesFallback() {
  const tradesDb = require('../db/queries/trades');
  const openTrades = await tradesDb.getOpen();
  const closed = [];

  for (const trade of openTrades) {
    const sl = parseFloat(trade.sl_price);
    const tp = parseFloat(trade.tp_price);
    if (!sl && !tp) continue;

    const priceData = await fetchLivePrice(trade.symbol);
    if (!priceData?.price) {
      console.warn(`[FALLBACK] Could not fetch price for ${trade.symbol} — skipping trade #${trade.id}`);
      continue;
    }

    const currentPrice = priceData.price;
    const entry = parseFloat(trade.actual_fill_price || trade.entry_price);
    const qty = parseFloat(trade.quantity);
    let action = null;

    if (trade.side === 'buy') {
      if (tp && currentPrice >= tp) action = 'tp_hit';
      else if (sl && currentPrice <= sl) action = 'sl_hit';
    } else {
      if (tp && currentPrice <= tp) action = 'tp_hit';
      else if (sl && currentPrice >= sl) action = 'sl_hit';
    }

    if (action) {
      // Use atomic close with SELECT FOR UPDATE to prevent race with position review
      const result = await tradesDb.closeTradeAtomic(
        trade.id,
        async () => {
          const pnl = trade.side === 'buy'
            ? (currentPrice - entry) * qty
            : (entry - currentPrice) * qty;
          const pnlPct = trade.side === 'buy'
            ? ((currentPrice - entry) / entry) * 100
            : ((entry - currentPrice) / entry) * 100;
          return {
            exit_price: currentPrice,
            pnl: Math.round(pnl * 10000) / 10000,
            pnlPct: Math.round(pnlPct * 10000) / 10000,
          };
        },
        {
          outcome_reasoning: `Node.js fallback: ${action} @ ${currentPrice} (source: ${priceData.source})`,
          close_reason: action,
        }
      );

      if (result) {
        console.log(`[FALLBACK] ${action} — trade #${trade.id} ${trade.symbol} ${trade.side} closed @ ${currentPrice} (P&L: ${result.pnl_pct}%)`);
        closed.push({ trade_id: trade.id, action, exit_price: currentPrice, pnl_pct: result.pnl_pct });
      } else {
        console.log(`[FALLBACK] Trade #${trade.id} already closed — skipping`);
      }
    }
  }

  return closed;
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
          signal: AbortSignal.timeout(30_000),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      } catch (err) {
        console.error(`[CANDLES] ${symbol} ${tf}:`, err.message);
      }
    }
  }
}

module.exports = {
  PYTHON_ENGINE_URL,
  CANDLE_SYMBOLS,
  fetchLivePrice,
  getOldPrices24h,
  getChange24hBatch,
  getLivePricesWithChange,
  checkStopLossesFallback,
  refreshCandles,
};
