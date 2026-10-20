import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDataStore } from '../stores/data';

const PRICE_REFRESH_MS = 30_000;
const STALE_AFTER_MS = 90_000;

// 'BTC/USDT' -> 'BTC-USDT'; null-safe
export function priceKey(symbol) {
  if (!symbol) return null;
  return String(symbol).replace('/', '-');
}

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Shared data layer for Dashboard (desktop) and MobileDashboard: initial fetch, price polling,
// live P&L derivation and price freshness. The pages only differ in layout.
//
//   options.agents  also fetch agents/regime (desktop command centre shows regime)
//   options.equity  also fetch the equity curve
export default function useDashboardData({ agents = false, equity = false } = {}) {
  const actions = useDataStore(useShallow(s => ({
    fetchPortfolio: s.fetchPortfolio,
    fetchAgents: s.fetchAgents,
    fetchSignals: s.fetchSignals,
    fetchTrades: s.fetchTrades,
    fetchSystem: s.fetchSystem,
    fetchEquity: s.fetchEquity,
    fetchPrices: s.fetchPrices,
  })));

  const prices = useDataStore(s => s.prices);
  const openTrades = useDataStore(s => s.openTrades);
  const tradeStats = useDataStore(s => s.tradeStats);
  const realisedPnl = useDataStore(s => s.realisedPnl);
  const startingCapital = useDataStore(s => s.startingCapital);
  const portfolioValue = useDataStore(s => s.portfolioValue);
  const resources = useDataStore(s => s.resources);
  const pricesUpdatedAt = useDataStore(s => s.pricesUpdatedAt);
  const pricesSource = useDataStore(s => s.pricesSource);
  const priceError = useDataStore(s => s.priceError);

  const reload = useCallback(() => Promise.all([
    actions.fetchPortfolio(),
    actions.fetchSignals(),
    actions.fetchTrades(),
    actions.fetchSystem(),
    actions.fetchPrices(),
    agents ? actions.fetchAgents() : null,
    equity ? actions.fetchEquity() : null,
  ]), [actions, agents, equity]);

  const retry = useCallback((key) => {
    const map = {
      portfolio: actions.fetchPortfolio,
      signals: actions.fetchSignals,
      trades: actions.fetchTrades,
      system: actions.fetchSystem,
      agents: actions.fetchAgents,
      equity: actions.fetchEquity,
    };
    return map[key]?.();
  }, [actions]);

  useEffect(() => {
    reload();
    const priceInterval = setInterval(actions.fetchPrices, PRICE_REFRESH_MS);
    return () => clearInterval(priceInterval);
    // reload is intentionally excluded: it only changes when the options change, and we only
    // want one initial load plus one price interval per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-evaluate staleness without needing a price write
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const priceStatus = useMemo(() => {
    const age = pricesUpdatedAt == null ? null : now - pricesUpdatedAt;
    return {
      error: priceError,
      source: pricesSource,
      ageMs: age,
      // Stale = never loaded, errored, older than 90s, or only DB candles (delayed) available
      stale: !!priceError || age == null || age > STALE_AFTER_MS || pricesSource === 'candles',
      label: priceError ? 'PRICES UNAVAILABLE'
        : pricesSource === 'candles' ? 'DELAYED PRICES'
        : age != null && age > STALE_AFTER_MS ? 'STALE PRICES'
        : null,
    };
  }, [now, pricesUpdatedAt, pricesSource, priceError]);

  const live = useMemo(() => {
    let sum = 0;
    let priced = 0;
    const list = openTrades || [];
    for (const t of list) {
      const cur = num(prices[priceKey(t.symbol)]?.price);
      const entry = num(t.actual_fill_price || t.entry_price);
      const qty = num(t.quantity);
      if (!(cur > 0) || entry == null || qty == null) continue;
      sum += t.side === 'buy' ? (cur - entry) * qty : (entry - cur) * qty;
      priced++;
    }
    return { unrealised: sum, partial: priced < list.length };
  }, [openTrades, prices]);

  const pnl = useMemo(() => {
    const known = realisedPnl != null;
    const closedCount = parseInt(tradeStats?.total_closed || 0, 10);
    return {
      liveUnrealised: live.unrealised,
      partial: live.partial,
      // null (unknown) until the portfolio has loaded; never a made-up 0 or 10000
      total: known ? realisedPnl + live.unrealised : null,
      livePortfolioValue: known && startingCapital != null ? startingCapital + realisedPnl + live.unrealised : null,
      closedCount,
      winRate: closedCount > 0 ? parseFloat(tradeStats?.win_rate || 0) : null,
    };
  }, [live, realisedPnl, startingCapital, tradeStats]);

  return {
    prices, openTrades, tradeStats, portfolioValue, realisedPnl, startingCapital,
    resources, pnl, priceStatus,
    reload, retry, fetchPrices: actions.fetchPrices,
  };
}
