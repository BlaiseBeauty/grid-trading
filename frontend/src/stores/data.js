import { create } from 'zustand';
import { api } from '../lib/api';

// Postgres NUMERIC arrives as strings. Returns a finite number or null (never a fake default).
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const PRICE_HISTORY_LEN = 24;
const FALLBACK_SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];

// Per-resource request tracking: { loading, error, loadedAt }.
// "Empty" in the UI must mean "server confirmed empty"; a failed load sets `error`.
const inflight = {};

function track(key, set, fn) {
  if (inflight[key]) return inflight[key];
  set(s => ({
    resources: {
      ...s.resources,
      [key]: { loading: true, error: s.resources[key]?.error ?? null, loadedAt: s.resources[key]?.loadedAt ?? null },
    },
  }));
  const p = (async () => {
    try {
      await fn();
      set(s => ({ resources: { ...s.resources, [key]: { loading: false, error: null, loadedAt: Date.now() } } }));
    } catch (err) {
      console.error(`[data] ${key} fetch failed:`, err);
      const message = err?.message || 'Request failed';
      set(s => ({
        resources: {
          ...s.resources,
          [key]: { loading: false, error: message, loadedAt: s.resources[key]?.loadedAt ?? null },
        },
      }));
    } finally {
      delete inflight[key];
    }
  })();
  inflight[key] = p;
  return p;
}

export const useDataStore = create((set, get) => ({
  // Per-resource { loading, error, loadedAt } keyed by resource name
  resources: {},

  // Portfolio (null = not loaded yet / unknown; never a made-up default)
  portfolio: [],
  portfolioValue: null,
  startingCapital: null,
  realisedPnl: null,
  unrealisedPnl: null,
  tradeStats: null,

  // Equity curve
  equity: [],

  // Agents
  agents: null,
  decisions: [],
  regime: [],
  rejected: [],

  // Signals
  signals: [],

  // Trades
  trades: [],
  openTrades: [],

  // Templates & Learnings
  templates: [],
  antiPatterns: [],
  learnings: [],
  learningsSummary: [],

  // Standing Orders
  standingOrders: [],

  // Live prices { 'BTC-USDT': { price, change24h } }
  prices: {},
  // Short rolling history per symbol for sparklines { 'BTC-USDT': [n, ...] } (capped)
  priceHistory: {},
  pricesUpdatedAt: null,      // ms epoch of the last price write (live or fallback)
  pricesSource: null,         // 'live' | 'candles' | null
  priceError: null,           // string message when the last price fetch failed, else null

  // System
  system: null,
  costs: null,

  // WebSocket feed
  feed: [],
  lastCycle: null,
  cycleStatus: null, // { running, cycleNumber, agents, completed[] }

  // Intelligence bus events (ring buffer, max 50)
  busEvents: [],
  unreadBusCount: 0,

  // Trade execution flash
  tradeFlash: false,
  setTradeFlash: (val) => set({ tradeFlash: val }),

  // Batch price write: only changed symbols get new objects / history arrays.
  // `batch` is { [symbol]: { price, change24h } }.
  applyPrices: (batch, source = 'live') => set(s => {
    let prices = s.prices;
    let priceHistory = s.priceHistory;
    let changed = false;
    for (const [symbol, data] of Object.entries(batch)) {
      const price = numOrNull(data.price);
      if (price == null) continue;
      const change24h = data.change24h == null ? null : numOrNull(data.change24h);
      const prev = prices[symbol];
      if (prev && prev.price === price && prev.change24h === change24h) continue;
      if (!changed) {
        prices = { ...prices };
        priceHistory = { ...priceHistory };
        changed = true;
      }
      prices[symbol] = { price, change24h };
      priceHistory[symbol] = [...(priceHistory[symbol] || []), price].slice(-PRICE_HISTORY_LEN);
    }
    return {
      prices,
      priceHistory,
      pricesUpdatedAt: Date.now(),
      pricesSource: source,
      priceError: null,
    };
  }),

  updatePrice: (symbol, price, change24h) => get().applyPrices({ [symbol]: { price, change24h } }),

  addFeedItem: (item) => set(s => ({
    feed: [{ ...item, ts: Date.now() }, ...s.feed].slice(0, 100),
  })),

  setLastCycle: (data) => set({ lastCycle: data }),

  setCycleStatus: (status) => set({ cycleStatus: status }),

  // Backtest progress (WebSocket)
  backtestProgress: null,
  setBacktestProgress: (data) => set({ backtestProgress: data }),

  // Calibration updates (WebSocket 'calibration_update'): a counter + last payload that
  // components can subscribe to (see CalibrationChart).
  calibrationUpdate: null,
  setCalibrationUpdate: (data) => set({ calibrationUpdate: { data, at: Date.now() } }),

  addCompletedAgent: (data) => set(s => {
    if (!s.cycleStatus) return {};
    return { cycleStatus: { ...s.cycleStatus, completed: [...s.cycleStatus.completed, data] } };
  }),

  // Fetchers — each sets resources[key] = { loading, error, loadedAt }
  fetchPortfolio: () => track('portfolio', set, async () => {
    const [portfolioData, stats] = await Promise.all([
      api('/portfolio'),
      api('/trades/stats'),
    ]);
    const { holdings = [], total_value, realised_pnl, unrealised_pnl, starting_capital } = portfolioData;
    const starting = numOrNull(starting_capital);
    set({
      portfolio: holdings,
      // total_value from the server; else the server's starting capital; else unknown (null).
      portfolioValue: numOrNull(total_value) ?? starting,
      startingCapital: starting,
      realisedPnl: numOrNull(realised_pnl),
      unrealisedPnl: numOrNull(unrealised_pnl),
      tradeStats: stats,
    });
  }),

  fetchAgents: () => track('agents', set, async () => {
    const [agents, decisions, regime, rejected] = await Promise.all([
      api('/agents'),
      api('/agents/decisions?limit=30'),
      api('/agents/regime'),
      api('/agents/rejected?limit=20'),
    ]);
    set({ agents, decisions, regime, rejected });
  }),

  fetchSignals: () => track('signals', set, async () => {
    const signals = await api('/signals/active');
    set({ signals });
  }),

  fetchTrades: () => track('trades', set, async () => {
    const [trades, openTrades] = await Promise.all([
      api('/trades?limit=50'),
      api('/trades/open'),
    ]);
    set({ trades, openTrades });
  }),

  fetchStandingOrders: () => track('standingOrders', set, async () => {
    const standingOrders = await api('/standing-orders');
    set({ standingOrders });
  }),

  fetchTemplates: () => track('templates', set, async () => {
    const [templates, antiPatterns] = await Promise.all([
      api('/templates'),
      api('/anti-patterns'),
    ]);
    set({ templates, antiPatterns });
  }),

  fetchLearnings: () => track('learnings', set, async () => {
    const [learnings, learningsSummary] = await Promise.all([
      api('/learnings?limit=50'),
      api('/learnings/summary'),
    ]);
    set({ learnings, learningsSummary });
  }),

  fetchSystem: () => track('system', set, async () => {
    const [system, costs, lastCycle] = await Promise.all([
      api('/system/health-detail'),
      api('/costs/summary'),
      api('/system/last-cycle'),
    ]);
    set({ system, costs, lastCycle });
  }),

  fetchEquity: () => track('equity', set, async () => {
    const equity = await api('/system/equity');
    set({ equity: equity || [] });
  }),

  // Goes through api() so the Authorization header, 401 refresh and timeout apply.
  fetchPrices: async () => {
    let fetched = 0;
    let liveError = null;
    try {
      const prices = await api('/prices/live');
      const batch = {};
      for (const [symbol, data] of Object.entries(prices || {})) {
        if (data && numOrNull(data.price) != null && numOrNull(data.price) !== 0) {
          batch[symbol] = { price: data.price, change24h: data.change24h ?? null };
          fetched++;
        }
      }
      if (fetched > 0) get().applyPrices(batch, 'live');
    } catch (err) {
      liveError = err?.message || 'Live price fetch failed';
      console.error('[PRICES] Live price fetch failed:', liveError);
    }

    if (fetched > 0) return;

    // Fallback: read DB candles in parallel when the live endpoint returned nothing or failed
    const results = await Promise.allSettled(
      FALLBACK_SYMBOLS.map(async (symbol) => {
        const candles = await api(`/market-data/${symbol}?timeframe=1h&limit=25`);
        if (!candles?.length) return null;
        const close = numOrNull(candles[candles.length - 1].close);
        const old = numOrNull(candles[0].close);
        if (close == null) return null;
        const change24h = old != null && old > 0 ? ((close - old) / old) * 100 : null;
        return [symbol, { price: close, change24h }];
      })
    );
    const batch = {};
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) batch[r.value[0]] = r.value[1];
      else if (r.status === 'rejected') console.error('[PRICES] DB candle fallback failed:', r.reason?.message || r.reason);
    }
    if (Object.keys(batch).length > 0) {
      get().applyPrices(batch, 'candles');
    } else {
      set({ priceError: liveError || 'No price data available' });
    }
  },

  // Actions
  triggerCycle: () => api('/agents/cycle', { method: 'POST', body: '{}' }),
  triggerAnalysis: () => api('/agents/analyse', { method: 'POST', body: '{}' }),
  refreshData: () => api('/agents/refresh-data', { method: 'POST', body: '{}' }),
}));
