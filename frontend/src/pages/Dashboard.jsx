import { useEffect, useRef, useState } from 'react';
import { useDataStore } from '../stores/data';
import {
  TickingNumber, GlowCard, StatusPulse, SignalBadge,
  ProgressRing, Sparkline, CountdownTimer, RangeBar,
} from '../components/ui';
import Chart from '../components/Chart';
import EquityCurve from '../components/EquityCurve';
import AgentFeed from '../components/AgentFeed';
import TradeDetail from '../components/TradeDetail';
import EventCalendar from '../components/EventCalendar';
import { timeAgo } from '../lib/format';

// Next cycle calculation (4h intervals aligned to 00:00 UTC)
function getNextCycleTime() {
  const now = new Date();
  const hours = now.getUTCHours();
  const nextSlot = Math.ceil((hours + 1) / 4) * 4;
  const next = new Date(now);
  next.setUTCHours(nextSlot >= 24 ? 0 : nextSlot, 0, 0, 0);
  if (nextSlot >= 24) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

const MARKET_SYMBOLS = [
  { key: 'BTC-USDT', label: 'BTC', full: 'Bitcoin' },
  { key: 'ETH-USDT', label: 'ETH', full: 'Ethereum' },
  { key: 'SOL-USDT', label: 'SOL', full: 'Solana' },
];

export default function Dashboard() {
  const fetchPortfolio = useDataStore(s => s.fetchPortfolio);
  const fetchAgents = useDataStore(s => s.fetchAgents);
  const fetchSignals = useDataStore(s => s.fetchSignals);
  const fetchTrades = useDataStore(s => s.fetchTrades);
  const fetchSystem = useDataStore(s => s.fetchSystem);
  const fetchPrices = useDataStore(s => s.fetchPrices);
  const fetchEquity = useDataStore(s => s.fetchEquity);
  const triggerCycle = useDataStore(s => s.triggerCycle);
  const refreshData = useDataStore(s => s.refreshData);
  const signals = useDataStore(s => s.signals);
  const regime = useDataStore(s => s.regime);
  const openTrades = useDataStore(s => s.openTrades);
  const lastCycle = useDataStore(s => s.lastCycle);
  const system = useDataStore(s => s.system);
  const prices = useDataStore(s => s.prices);
  const realisedPnl = useDataStore(s => s.realisedPnl);
  const startingCapital = useDataStore(s => s.startingCapital);
  const tradeStats = useDataStore(s => s.tradeStats);
  const costs = useDataStore(s => s.costs);
  const equity = useDataStore(s => s.equity);
  const cycleStatus = useDataStore(s => s.cycleStatus);
  const tradeFlash = useDataStore(s => s.tradeFlash);
  const setTradeFlash = useDataStore(s => s.setTradeFlash);
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [nextCycle] = useState(getNextCycleTime);
  const [priceHistory, setPriceHistory] = useState({});

  useEffect(() => {
    fetchPortfolio();
    fetchAgents();
    fetchSignals();
    fetchTrades();
    fetchSystem();
    fetchEquity();
    fetchPrices();
    const priceInterval = setInterval(fetchPrices, 30_000);
    return () => clearInterval(priceInterval);
  }, []);

  // Build sparkline data from price updates
  useEffect(() => {
    setPriceHistory(prev => {
      const next = { ...prev };
      for (const sym of MARKET_SYMBOLS) {
        const p = prices[sym.key]?.price;
        if (p) {
          const arr = next[sym.key] || [];
          next[sym.key] = [...arr, p].slice(-24);
        }
      }
      return next;
    });
  }, [prices]);

  // Clear trade flash after animation
  useEffect(() => {
    if (tradeFlash) {
      const timer = setTimeout(() => setTradeFlash(false), 800);
      return () => clearTimeout(timer);
    }
  }, [tradeFlash]);

  // Track previous trade IDs for slide-in animation
  const prevTradeIdsRef = useRef(null);
  if (prevTradeIdsRef.current === null) {
    prevTradeIdsRef.current = new Set((openTrades || []).map(t => t.id));
  }
  const newTradeIds = new Set(
    (openTrades || []).filter(t => !prevTradeIdsRef.current.has(t.id)).map(t => t.id)
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      prevTradeIdsRef.current = new Set((openTrades || []).map(t => t.id));
    }, 500);
    return () => clearTimeout(timer);
  }, [openTrades]);

  // Compute live P&L
  const liveUnrealisedPnl = (openTrades || []).reduce((sum, t) => {
    const entry = parseFloat(t.actual_fill_price || t.entry_price);
    const qty = parseFloat(t.quantity);
    const curPrice = prices[t.symbol.replace('/', '-')]?.price;
    if (!curPrice) return sum;
    return sum + (t.side === 'buy' ? (curPrice - entry) * qty : (entry - curPrice) * qty);
  }, 0);
  const totalPnl = realisedPnl + liveUnrealisedPnl;
  const livePortfolioValue = startingCapital + realisedPnl + liveUnrealisedPnl;
  const closedCount = parseInt(tradeStats?.total_closed || 0);
  const winRate = closedCount > 0 ? parseFloat(tradeStats?.win_rate || 0) : null;
  const totalCost = costs?.total_spend ? parseFloat(costs.total_spend) : 0;

  return (
    <div className={`v2-dashboard ${cycleStatus?.running ? 'v2-cycle-active' : ''}`}>
      {/* ── Header ── */}
      <div className="v2-header v2-animate-in">
        <h1 className="v2-title">COMMAND CENTRE</h1>
        <div className="v2-header-actions">
          <button className="v2-btn" onClick={() => refreshData().catch(() => {})}>
            Refresh
          </button>
          <button className="v2-btn v2-btn--primary" onClick={() => triggerCycle().catch(() => {})}>
            Run Cycle
          </button>
        </div>
      </div>

      {/* ── KPI Strip ── */}
      <div className="v2-kpi-strip">
        <GlowCard className="v2-kpi v2-animate-in v2-stagger-1">
          <div className="v2-kpi-label">Portfolio Value</div>
          <TickingNumber value={livePortfolioValue} format="money" decimals={2} colorize={false} />
        </GlowCard>
        <GlowCard className="v2-kpi v2-animate-in v2-stagger-2" glowColor={totalPnl >= 0 ? 'green' : 'red'}>
          <div className="v2-kpi-label">Total P&L</div>
          <TickingNumber value={totalPnl} format="money" decimals={2} />
        </GlowCard>
        <GlowCard className="v2-kpi v2-kpi--ring v2-animate-in v2-stagger-3">
          <div className="v2-kpi-label">Win Rate</div>
          <ProgressRing value={winRate ?? 0} size={52} strokeWidth={3} label={winRate === null ? '--' : undefined} />
        </GlowCard>
        <GlowCard className="v2-kpi v2-animate-in v2-stagger-4">
          <div className="v2-kpi-label">Open Positions</div>
          <div className="v2-kpi-positions">
            <TickingNumber value={openTrades?.length || 0} format="number" decimals={0} colorize={false} className="v2-kpi-big-num" />
            <div className="v2-kpi-dots">
              {(openTrades || []).slice(0, 8).map((t, i) => (
                <StatusPulse key={i} status="active" size={5} />
              ))}
            </div>
          </div>
        </GlowCard>
        <GlowCard className="v2-kpi v2-animate-in v2-stagger-5" glowColor="magenta">
          <div className="v2-kpi-label">AI Cost</div>
          <TickingNumber value={totalCost} format="money" decimals={2} colorize={false} />
        </GlowCard>
        <GlowCard className="v2-kpi v2-animate-in v2-stagger-6">
          <div className="v2-kpi-label">Next Cycle</div>
          <CountdownTimer targetTime={nextCycle} />
        </GlowCard>
      </div>

      {/* ── Cycle Pipeline ── */}
      {cycleStatus?.running && (
        <CyclePipeline cycleStatus={cycleStatus} />
      )}

      {/* ── Market Row ── */}
      <div className="v2-market-row">
        {MARKET_SYMBOLS.map((sym, i) => {
          const p = prices[sym.key];
          const change = p?.change24h || 0;
          const sparkData = priceHistory[sym.key] || [];
          return (
            <GlowCard
              key={sym.key}
              className={`v2-market-card v2-animate-in v2-stagger-${i + 1}`}
              glowColor={change >= 0 ? 'green' : 'red'}
            >
              <div className="v2-market-top">
                <div>
                  <span className="v2-market-symbol">{sym.label}</span>
                  <span className="v2-market-full">{sym.full}</span>
                </div>
                <StatusPulse status={p ? 'active' : 'idle'} size={6} />
              </div>
              <div className="v2-market-price">
                <TickingNumber value={p?.price || 0} format="money" decimals={sym.label === 'SOL' ? 2 : 2} colorize={false} />
              </div>
              <div className="v2-market-bottom">
                <SignalBadge direction={change >= 0.5 ? 'bullish' : change <= -0.5 ? 'bearish' : 'neutral'} />
                <TickingNumber value={change} format="pct" decimals={2} />
                <Sparkline
                  data={sparkData}
                  width={72}
                  height={20}
                  color={change >= 0 ? 'var(--v2-accent-green)' : 'var(--v2-accent-red)'}
                  filled
                />
              </div>
            </GlowCard>
          );
        })}
      </div>

      {/* ── Charts ── */}
      <div className="v2-charts-row v2-animate-in v2-stagger-3">
        <Chart />
        <GlowCard className="v2-equity-wrap" padding="0">
          <EquityCurve data={equity} />
        </GlowCard>
      </div>

      {/* ── Main Grid ── */}
      <div className="v2-grid">
        {/* Positions */}
        <GlowCard className={`v2-section v2-animate-in v2-stagger-4 ${tradeFlash ? 'v2-trade-flash' : ''}`}>
          <div className="v2-section-title">Open Positions <span className="v2-count">{openTrades?.length || 0}</span></div>
          {(!openTrades || openTrades.length === 0) ? (
            <div className="v2-empty">
              <StatusPulse status="idle" size={6} label="No open positions" />
            </div>
          ) : (
            <div className="v2-positions">
              {openTrades.map((t, i) => (
                <PositionCard
                  key={t.id || i}
                  trade={t}
                  prices={prices}
                  isNew={newTradeIds.has(t.id)}
                  onClick={() => setSelectedTrade(t)}
                />
              ))}
            </div>
          )}
        </GlowCard>

        {/* Agent Activity */}
        <GlowCard className="v2-section v2-feed-section v2-animate-in v2-stagger-5" padding="0">
          <AgentFeed />
        </GlowCard>

        {/* Market Regime */}
        <GlowCard className="v2-section v2-animate-in v2-stagger-6">
          <div className="v2-section-title">Market Regime</div>
          {regime.length === 0 ? (
            <div className="v2-empty">No regime data</div>
          ) : regime.map((r, i) => {
            const glowStyle = r.regime?.includes('up') ? 'var(--v2-glow-green)'
              : r.regime?.includes('down') ? 'var(--v2-glow-red)' : 'var(--v2-glow-amber)';
            const color = r.regime?.includes('up') ? 'var(--v2-accent-green)'
              : r.regime?.includes('down') ? 'var(--v2-accent-red)' : 'var(--v2-accent-amber)';
            return (
              <div key={i} className="v2-regime-row">
                <span className="v2-regime-class">{r.asset_class}</span>
                <span className="v2-regime-badge" style={{ color, boxShadow: glowStyle, borderColor: color }}>
                  {r.regime}
                </span>
                {r.sub_regime && <span className="v2-regime-sub">{r.sub_regime}</span>}
                <ProgressRing value={r.confidence || 0} size={36} strokeWidth={2.5} color={color} />
              </div>
            );
          })}
        </GlowCard>

        {/* Last Cycle */}
        <GlowCard className="v2-section v2-animate-in v2-stagger-7">
          <div className="v2-section-title">Last Cycle</div>
          {!lastCycle ? (
            <div className="v2-empty">No cycles run yet</div>
          ) : (
            <div className="v2-cycle-info">
              <div className="v2-cycle-header">
                <span className="v2-cycle-num">#{lastCycle.cycleNumber}</span>
                <span className="v2-cycle-elapsed">{lastCycle.elapsed}</span>
              </div>
              {lastCycle.strategy && (
                <div className="v2-cycle-strategy">
                  <div className="v2-cycle-stat">
                    <span className="v2-cycle-stat-label">Proposals</span>
                    <TickingNumber value={lastCycle.strategy.proposals || 0} format="number" decimals={0} colorize={false} className="v2-cycle-stat-value" />
                  </div>
                  <div className="v2-cycle-stat">
                    <span className="v2-cycle-stat-label">Approved</span>
                    <TickingNumber value={lastCycle.strategy.approved || 0} format="number" decimals={0} className="v2-cycle-stat-value" />
                  </div>
                  <div className="v2-cycle-stat">
                    <span className="v2-cycle-stat-label">Rejected</span>
                    <TickingNumber value={lastCycle.strategy.rejected || 0} format="number" decimals={0} className="v2-cycle-stat-value" />
                  </div>
                  <div className="v2-cycle-stat">
                    <span className="v2-cycle-stat-label">Executed</span>
                    <TickingNumber value={lastCycle.strategy.trades || 0} format="number" decimals={0} colorize={false} className="v2-cycle-stat-value" />
                  </div>
                </div>
              )}
              {lastCycle.agents && (
                <div className="v2-agent-bars">
                  {lastCycle.agents.map((a, i) => {
                    const maxSigs = Math.max(...lastCycle.agents.map(x => x.signals || 0), 1);
                    return (
                      <div key={i} className="v2-agent-bar-row">
                        <span className="v2-agent-bar-name">{a.agent}</span>
                        <div className="v2-agent-bar-track">
                          <div
                            className="v2-agent-bar-fill"
                            style={{
                              width: `${((a.signals || 0) / maxSigs) * 100}%`,
                              backgroundColor: a.status === 'fulfilled' ? 'var(--v2-accent-magenta)' : 'var(--v2-accent-red)',
                            }}
                          />
                        </div>
                        <span className="v2-agent-bar-count">{a.signals || 0}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </GlowCard>

        {/* System Health */}
        <GlowCard className="v2-section v2-animate-in v2-stagger-8">
          <div className="v2-section-title">System Health</div>
          {!system ? (
            <div className="v2-empty">Loading...</div>
          ) : (
            <div className="v2-health">
              <div className="v2-health-row">
                <span className="v2-health-label">Bootstrap</span>
                <StatusPulse
                  status={system.bootstrap_phase === 'graduated' ? 'active' : 'warning'}
                  label={system.bootstrap_phase}
                />
              </div>
              <div className="v2-health-row">
                <span className="v2-health-label">Total Trades</span>
                <TickingNumber value={system.trade_stats?.total_trades || 0} format="number" decimals={0} colorize={false} />
              </div>
              <div className="v2-health-row">
                <span className="v2-health-label">Win Rate</span>
                <ProgressRing
                  value={winRate ?? 0}
                  size={40}
                  strokeWidth={3}
                  color={winRate != null && winRate >= 50 ? 'var(--v2-accent-green)' : 'var(--v2-accent-amber)'}
                  label={winRate === null ? '--' : undefined}
                />
              </div>
              <div className="v2-health-row">
                <span className="v2-health-label">SCRAM</span>
                <StatusPulse
                  status={system.scram_active ? 'error' : 'active'}
                  label={system.scram_active ? system.scram_level : 'Clear'}
                />
              </div>
              <div className="v2-health-row">
                <span className="v2-health-label">Mode</span>
                <span className="v2-health-value">{system.live_trading ? 'LIVE' : 'PAPER'}</span>
              </div>
            </div>
          )}
        </GlowCard>

        {/* Event Calendar */}
        <GlowCard className="v2-section v2-animate-in v2-stagger-8" padding="0">
          <EventCalendar />
        </GlowCard>
      </div>

      <TradeDetail
        trade={selectedTrade}
        open={!!selectedTrade}
        onClose={() => setSelectedTrade(null)}
      />

      <style>{`
        /* ── Layout ── */
        .v2-dashboard {
          display: flex;
          flex-direction: column;
          gap: var(--v2-space-sm);
          transition: border-color var(--v2-duration-normal);
        }
        .v2-dashboard.v2-cycle-active {
          border: 1px solid rgba(0, 229, 255, 0.15);
          border-radius: var(--v2-radius-lg);
          padding: var(--v2-space-md);
          animation: v2-pulse-glow 2s ease-in-out infinite;
        }

        /* ── Header ── */
        .v2-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--v2-space-xs) 0;
        }
        .v2-title {
          font-family: 'Syne', sans-serif;
          font-weight: 800;
          font-size: 16px;
          letter-spacing: 6px;
          color: var(--v2-text-primary);
        }
        .v2-header-actions { display: flex; gap: var(--v2-space-sm); }
        .v2-btn {
          padding: 6px 14px;
          border: 1px solid var(--v2-border-hover);
          border-radius: var(--v2-radius-sm);
          font-family: var(--v2-font-data);
          font-size: 10px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--v2-text-secondary);
          background: transparent;
          cursor: pointer;
          transition: all var(--v2-duration-fast) var(--v2-ease-out);
        }
        .v2-btn:hover { border-color: var(--v2-accent-cyan); color: var(--v2-accent-cyan); }
        .v2-btn--primary {
          background: var(--v2-accent-cyan);
          color: var(--v2-bg-primary);
          border-color: var(--v2-accent-cyan);
          font-weight: 600;
        }
        .v2-btn--primary:hover { opacity: 0.85; }

        /* ── KPI Strip ── */
        .v2-kpi-strip {
          display: flex;
          gap: var(--v2-space-sm);
          overflow-x: auto;
          scrollbar-width: none;
        }
        .v2-kpi-strip::-webkit-scrollbar { display: none; }
        .v2-kpi {
          min-width: 140px;
          flex: 1;
        }
        .v2-kpi .v2-ticking-number {
          font-size: 18px;
          font-weight: 400;
        }
        .v2-kpi-label {
          font-family: var(--v2-font-data);
          font-size: 9px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--v2-text-muted);
          margin-bottom: var(--v2-space-xs);
        }
        .v2-kpi--ring {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
        }
        .v2-kpi-positions {
          display: flex;
          align-items: center;
          gap: var(--v2-space-md);
        }
        .v2-kpi-big-num {
          font-family: var(--v2-font-data);
          font-size: 20px;
          font-weight: 400;
          color: var(--v2-text-primary);
          font-variant-numeric: tabular-nums;
        }
        .v2-kpi-dots {
          display: flex;
          gap: 3px;
          align-items: center;
        }

        /* ── Market Row ── */
        .v2-market-row {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: var(--v2-space-sm);
        }
        .v2-market-card { min-width: 0; }
        .v2-market-top {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: var(--v2-space-sm);
        }
        .v2-market-symbol {
          font-family: var(--v2-font-data);
          font-weight: 600;
          font-size: 14px;
          color: var(--v2-text-primary);
          margin-right: var(--v2-space-sm);
        }
        .v2-market-full {
          font-family: var(--v2-font-body);
          font-size: 11px;
          color: var(--v2-text-muted);
        }
        .v2-market-price {
          margin-bottom: var(--v2-space-sm);
        }
        .v2-market-price .v2-ticking-number {
          font-size: 22px;
          font-weight: 400;
        }
        .v2-market-bottom {
          display: flex;
          align-items: center;
          gap: var(--v2-space-sm);
        }
        .v2-market-bottom .v2-ticking-number {
          font-size: 12px;
        }

        /* ── Charts ── */
        .v2-charts-row {
          display: grid;
          grid-template-columns: 1fr;
          gap: var(--v2-space-sm);
        }
        .v2-equity-wrap { overflow: hidden; }
        .v2-equity-wrap .equity-panel { border: none; background: transparent; }

        /* ── Main Grid ── */
        .v2-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: var(--v2-space-sm);
        }

        /* ── Section Cards ── */
        .v2-section-title {
          font-family: var(--v2-font-data);
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          color: var(--v2-text-muted);
          margin-bottom: var(--v2-space-md);
        }
        .v2-count {
          color: var(--v2-accent-cyan);
          margin-left: var(--v2-space-xs);
        }
        .v2-empty {
          color: var(--v2-text-muted);
          font-family: var(--v2-font-body);
          font-size: 13px;
          padding: var(--v2-space-xl) 0;
          text-align: center;
        }
        .v2-muted {
          color: var(--v2-text-muted);
          font-family: var(--v2-font-data);
        }

        /* ── Positions ── */
        .v2-positions {
          display: flex;
          flex-direction: column;
          gap: var(--v2-space-sm);
        }
        .v2-position {
          padding: var(--v2-space-md);
          background: var(--v2-bg-hover);
          border: 1px solid var(--v2-border);
          border-radius: var(--v2-radius-sm);
          cursor: pointer;
          transition: all var(--v2-duration-fast) var(--v2-ease-out);
        }
        .v2-position:hover {
          border-color: var(--v2-border-hover);
          background: rgba(0,0,0,0.03);
        }
        .v2-pos-header {
          display: flex;
          align-items: center;
          gap: var(--v2-space-sm);
          margin-bottom: var(--v2-space-sm);
        }
        .v2-pos-symbol {
          font-family: var(--v2-font-data);
          font-weight: 600;
          font-size: 13px;
          color: var(--v2-text-primary);
        }
        .v2-pos-time {
          font-family: var(--v2-font-data);
          font-size: 10px;
          color: var(--v2-text-muted);
          margin-left: auto;
        }
        .v2-pos-prices {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: var(--v2-space-sm);
          margin-bottom: var(--v2-space-sm);
        }
        .v2-pos-col {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .v2-pos-label {
          font-family: var(--v2-font-data);
          font-size: 9px;
          color: var(--v2-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .v2-pos-entry {
          font-family: var(--v2-font-data);
          font-size: 12px;
          color: var(--v2-text-secondary);
          font-variant-numeric: tabular-nums;
        }
        .v2-pos-col .v2-ticking-number { font-size: 12px; }

        /* ── Feed ── */
        .v2-feed-section {
          max-height: 500px;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: var(--v2-border-hover) transparent;
        }
        .v2-feed-section .panel-title { padding: var(--v2-space-lg); margin-bottom: 0; }
        .v2-feed-section .agent-feed { max-height: none; }

        /* ── Regime ── */
        .v2-regime-row {
          display: flex;
          align-items: center;
          gap: var(--v2-space-md);
          padding: var(--v2-space-sm) 0;
        }
        .v2-regime-class {
          font-family: var(--v2-font-data);
          font-weight: 500;
          font-size: 12px;
          color: var(--v2-text-secondary);
          min-width: 50px;
          text-transform: uppercase;
        }
        .v2-regime-badge {
          font-family: var(--v2-font-data);
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          padding: 4px 12px;
          border-radius: var(--v2-radius-full);
          border: 1px solid;
        }
        .v2-regime-sub {
          font-family: var(--v2-font-body);
          font-size: 11px;
          color: var(--v2-text-muted);
          flex: 1;
        }

        /* ── Last Cycle ── */
        .v2-cycle-info { display: flex; flex-direction: column; gap: var(--v2-space-md); }
        .v2-cycle-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .v2-cycle-num {
          font-family: var(--v2-font-data);
          font-size: 18px;
          font-weight: 500;
          color: var(--v2-accent-cyan);
        }
        .v2-cycle-elapsed {
          font-family: var(--v2-font-data);
          font-size: 12px;
          color: var(--v2-text-muted);
        }
        .v2-cycle-strategy {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: var(--v2-space-sm);
        }
        .v2-cycle-stat {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .v2-cycle-stat-label {
          font-family: var(--v2-font-data);
          font-size: 9px;
          color: var(--v2-text-muted);
          text-transform: uppercase;
        }
        .v2-cycle-stat-value {
          font-family: var(--v2-font-data);
          font-size: 16px;
          font-weight: 500;
          color: var(--v2-text-primary);
          font-variant-numeric: tabular-nums;
        }

        /* ── Agent Signal Bars ── */
        .v2-agent-bars {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .v2-agent-bar-row {
          display: flex;
          align-items: center;
          gap: var(--v2-space-sm);
        }
        .v2-agent-bar-name {
          font-family: var(--v2-font-data);
          font-size: 9px;
          font-weight: 500;
          color: var(--v2-text-muted);
          text-transform: uppercase;
          min-width: 72px;
        }
        .v2-agent-bar-track {
          flex: 1;
          height: 4px;
          background: var(--v2-border);
          border-radius: 2px;
          overflow: hidden;
        }
        .v2-agent-bar-fill {
          height: 100%;
          border-radius: 2px;
          transition: width var(--v2-duration-slow) var(--v2-ease-out);
        }
        .v2-agent-bar-count {
          font-family: var(--v2-font-data);
          font-size: 10px;
          font-weight: 500;
          color: var(--v2-accent-magenta);
          min-width: 18px;
          text-align: right;
        }

        /* ── System Health ── */
        .v2-health {
          display: flex;
          flex-direction: column;
          gap: var(--v2-space-sm);
        }
        .v2-health-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--v2-space-xs) 0;
        }
        .v2-health-label {
          font-family: var(--v2-font-body);
          font-size: 12px;
          color: var(--v2-text-secondary);
        }
        .v2-health-value {
          font-family: var(--v2-font-data);
          font-size: 13px;
          font-weight: 500;
          color: var(--v2-text-primary);
        }

        /* ── Cycle Pipeline ── */
        .v2-pipeline {
          padding: var(--v2-space-sm) 0;
        }
        .v2-pipeline-stages {
          display: flex;
          justify-content: space-between;
          margin-bottom: var(--v2-space-xs);
        }
        .v2-pipeline-stage {
          display: flex;
          align-items: center;
          gap: var(--v2-space-xs);
        }
        .v2-pipeline-dot {
          width: 6px; height: 6px;
          border-radius: 50%;
          background: var(--v2-text-muted);
          transition: all var(--v2-duration-normal);
        }
        .v2-pipeline-stage.v2-pipe-done .v2-pipeline-dot {
          background: var(--v2-accent-cyan);
          box-shadow: 0 0 6px rgba(0,229,255,0.4);
        }
        .v2-pipeline-stage.v2-pipe-active .v2-pipeline-dot {
          background: var(--v2-accent-cyan);
          animation: v2-status-pulse 1.5s ease-in-out infinite;
        }
        .v2-pipeline-label {
          font-family: var(--v2-font-data);
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--v2-text-muted);
        }
        .v2-pipeline-stage.v2-pipe-done .v2-pipeline-label { color: var(--v2-accent-cyan); }
        .v2-pipeline-stage.v2-pipe-active .v2-pipeline-label { color: var(--v2-text-secondary); }
        .v2-pipeline-track {
          height: 2px;
          background: var(--v2-border);
          border-radius: 1px;
          overflow: hidden;
        }
        .v2-pipeline-fill {
          height: 100%;
          background: var(--v2-accent-cyan);
          border-radius: 1px;
          transition: width 0.5s var(--v2-ease-out);
          box-shadow: 0 0 8px rgba(0,229,255,0.3);
        }

        /* ── Responsive ── */
        @media (max-width: 768px) {
          .v2-kpi-strip { flex-wrap: nowrap; }
          .v2-kpi { min-width: 120px; }
          .v2-market-row { grid-template-columns: 1fr; }
          .v2-grid { grid-template-columns: 1fr; }
          .v2-pos-prices { grid-template-columns: repeat(2, 1fr); }
          .v2-cycle-strategy { grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>
    </div>
  );
}

const PIPELINE_STAGES = ['knowledge', 'regime', 'synthesizer', 'risk_manager', 'execution'];
const STRATEGY_AGENTS = ['regime_classifier', 'synthesizer', 'risk_manager'];

function CyclePipeline({ cycleStatus }) {
  const completed = cycleStatus.completed || [];
  const knowledgeAgents = cycleStatus.agents || [];

  const statuses = [];
  for (let i = 0; i < PIPELINE_STAGES.length; i++) {
    const stage = PIPELINE_STAGES[i];
    if (stage === 'knowledge') {
      const knowledgeDone = completed.filter(c => !STRATEGY_AGENTS.includes(c.agent_name)).length;
      statuses.push(knowledgeDone >= knowledgeAgents.length ? 'done' : knowledgeDone > 0 ? 'active' : 'pending');
    } else if (stage === 'execution') {
      statuses.push(completed.some(c => c.agent_name === 'risk_manager') ? 'done' : statuses[i - 1] === 'done' ? 'active' : 'pending');
    } else {
      const agentName = stage === 'regime' ? 'regime_classifier' : stage;
      if (completed.some(c => c.agent_name === agentName)) {
        statuses.push('done');
      } else {
        statuses.push(statuses[i - 1] === 'done' ? 'active' : 'pending');
      }
    }
  }

  const doneCount = statuses.filter(s => s === 'done').length;
  const progress = (doneCount / PIPELINE_STAGES.length) * 100;

  const labels = { knowledge: 'knowledge', regime: 'regime', synthesizer: 'synth', risk_manager: 'risk', execution: 'exec' };

  return (
    <div className="v2-pipeline v2-animate-in">
      <div className="v2-pipeline-stages">
        {PIPELINE_STAGES.map((stage, i) => (
          <div key={stage} className={`v2-pipeline-stage v2-pipe-${statuses[i]}`}>
            <div className="v2-pipeline-dot" />
            <span className="v2-pipeline-label">{labels[stage]}</span>
          </div>
        ))}
      </div>
      <div className="v2-pipeline-track">
        <div className="v2-pipeline-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function PositionCard({ trade, prices, isNew, onClick }) {
  const pnlRef = useRef(null);
  const [pulse, setPulse] = useState(null);

  const entry = parseFloat(trade.actual_fill_price || trade.entry_price);
  const qty = parseFloat(trade.quantity);
  const curPrice = prices[trade.symbol.replace('/', '-')]?.price;
  const pnl = curPrice ? (trade.side === 'buy' ? (curPrice - entry) * qty : (entry - curPrice) * qty) : null;
  const pnlPct = pnl != null ? (pnl / (entry * qty)) * 100 : null;
  const sl = parseFloat(trade.sl_price) || 0;
  const tp = parseFloat(trade.tp_price) || 0;

  useEffect(() => {
    if (pnlRef.current !== null && pnl !== null && pnl !== pnlRef.current) {
      setPulse(pnl > pnlRef.current ? 'green' : 'red');
      const timer = setTimeout(() => setPulse(null), 600);
      return () => clearTimeout(timer);
    }
    if (pnl !== null) pnlRef.current = pnl;
  }, [pnl]);

  const pulseClass = pulse === 'green' ? 'v2-border-pulse-green'
    : pulse === 'red' ? 'v2-border-pulse-red' : '';

  return (
    <div
      className={`v2-position ${pulseClass} ${isNew ? 'v2-slide-in' : ''}`}
      onClick={onClick}
    >
      <div className="v2-pos-header">
        <span className="v2-pos-symbol">{trade.symbol}</span>
        <SignalBadge direction={trade.side === 'buy' ? 'long' : 'short'} />
        <span className="v2-pos-time">{timeAgo(trade.opened_at || trade.created_at)}</span>
      </div>
      <div className="v2-pos-prices">
        <div className="v2-pos-col">
          <span className="v2-pos-label">Entry</span>
          <span className="v2-pos-entry">${entry.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
        </div>
        <div className="v2-pos-col">
          <span className="v2-pos-label">Current</span>
          {curPrice ? <TickingNumber value={curPrice} format="money" colorize={false} /> : <span className="v2-muted">--</span>}
        </div>
        <div className="v2-pos-col">
          <span className="v2-pos-label">P&L</span>
          {pnl != null ? <TickingNumber value={pnl} format="money" /> : <span className="v2-muted">--</span>}
        </div>
        <div className="v2-pos-col">
          <span className="v2-pos-label">Return</span>
          {pnlPct != null ? <TickingNumber value={pnlPct} format="pct" /> : <span className="v2-muted">--</span>}
        </div>
      </div>
      {sl > 0 && tp > 0 && curPrice && (
        <RangeBar
          current={curPrice}
          low={Math.min(sl, tp)}
          high={Math.max(sl, tp)}
          side={trade.side}
        />
      )}
    </div>
  );
}
