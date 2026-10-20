import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { useDataStore } from '../stores/data';
import useDashboardData, { priceKey } from '../hooks/useDashboardData';
import {
  TickingNumber, GlowCard, StatusPulse, SignalBadge,
  ProgressRing, Sparkline, CountdownTimer, RangeBar,
} from '../components/ui';
import Chart from '../components/Chart';
import EquityCurve from '../components/EquityCurve';
import AgentFeed from '../components/AgentFeed';
import CycleReport from '../components/CycleReport';
import TradeDetail from '../components/TradeDetail';
import EventCalendar from '../components/EventCalendar';
import { timeAgo, fmtMoney } from '../lib/format';
import { ErrorState, LoadingState } from '../components/StateBlock';

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
  const {
    prices, openTrades, resources, pnl, priceStatus, reload, retry,
  } = useDashboardData({ agents: true, equity: true });
  const refreshData = useDataStore(s => s.refreshData);
  const regime = useDataStore(s => s.regime);
  const lastCycle = useDataStore(s => s.lastCycle);
  const system = useDataStore(s => s.system);
  const costs = useDataStore(s => s.costs);
  const equity = useDataStore(s => s.equity);
  const tradeFlash = useDataStore(s => s.tradeFlash);
  const setTradeFlash = useDataStore(s => s.setTradeFlash);
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [nextCycle] = useState(getNextCycleTime);
  const [refreshError, setRefreshError] = useState(null);

  const { winRate, total: totalPnl, livePortfolioValue } = pnl;

  // Clear trade flash after animation
  useEffect(() => {
    if (tradeFlash) {
      const timer = setTimeout(() => setTradeFlash(false), 800);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [tradeFlash, setTradeFlash]);

  // Track previous trade IDs for slide-in animation
  const prevTradeIdsRef = useRef(null);
  if (prevTradeIdsRef.current === null) {
    prevTradeIdsRef.current = new Set((openTrades || []).map(t => t.id));
  }
  const newTradeIds = useMemo(
    () => new Set((openTrades || []).filter(t => !prevTradeIdsRef.current.has(t.id)).map(t => t.id)),
    [openTrades]
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      prevTradeIdsRef.current = new Set((openTrades || []).map(t => t.id));
    }, 500);
    return () => clearTimeout(timer);
  }, [openTrades]);

  const totalCost = costs?.total_spend ? parseFloat(costs.total_spend) : 0;

  const handleRefresh = async () => {
    setRefreshError(null);
    try {
      await refreshData();
    } catch (err) {
      setRefreshError(err?.message || 'Refresh failed');
    }
    reload();
  };

  // Any failed core resource, shown as a banner with Retry (empty must mean confirmed-empty)
  const failed = ['portfolio', 'trades', 'system', 'agents', 'equity']
    .filter(k => resources[k]?.error)
    .map(k => ({ key: k, message: resources[k].error }));

  return (
    <div className="v2-dashboard">
      {/* ── Header ── */}
      <div className="v2-header v2-animate-in">
        <h1 className="v2-title">COMMAND CENTRE</h1>
        <div className="v2-header-actions">
          {priceStatus.label && <span className="stale-chip" role="status">{priceStatus.label}</span>}
          <button className="v2-btn" onClick={handleRefresh}>
            Refresh
          </button>
        </div>
      </div>

      {(failed.length > 0 || refreshError) && (
        <div className="state-block state-block--error" role="alert" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: '8px 12px' }}>
          {refreshError && <span>Refresh failed: {refreshError}</span>}
          {failed.map(f => (
            <span key={f.key}>
              {f.key} failed to load ({f.message}){' '}
              <button type="button" className="state-block__btn" onClick={() => retry(f.key)}>Retry</button>
            </span>
          ))}
        </div>
      )}

      {/* ── KPI Strip ── */}
      <div className="v2-kpi-strip">
        <GlowCard className="v2-kpi v2-animate-in v2-stagger-1">
          <div className="v2-kpi-label">Portfolio Value</div>
          {livePortfolioValue != null
            ? <TickingNumber value={livePortfolioValue} format="money" decimals={2} colorize={false} />
            : <span className="v2-muted" title="Portfolio not loaded">{'—'}</span>}
        </GlowCard>
        <GlowCard className="v2-kpi v2-animate-in v2-stagger-2" glowColor={totalPnl != null && totalPnl < 0 ? 'red' : 'green'}>
          <div className="v2-kpi-label">Total P&L</div>
          {totalPnl != null
            ? <TickingNumber value={totalPnl} format="money" decimals={2} />
            : <span className="v2-muted" title="Portfolio not loaded">{'—'}</span>}
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

      {/* ── Market Row ── */}
      <div className="v2-market-row">
        {MARKET_SYMBOLS.map((sym, i) => (
          <MarketCard key={sym.key} sym={sym} index={i} price={prices[sym.key]} />
        ))}
      </div>

      {/* ── Charts ── */}
      <div className="v2-charts-row v2-animate-in v2-stagger-3">
        <Chart />
        <GlowCard className="v2-equity-wrap" padding="0">
          <EquityCurve
            data={equity}
            loaded={resources.equity?.loadedAt != null}
            error={resources.equity?.error}
            onRetry={() => retry('equity')}
          />
        </GlowCard>
      </div>

      {/* ── Main Grid ── */}
      <div className="v2-grid">
        {/* Positions */}
        <GlowCard className={`v2-section v2-animate-in v2-stagger-4 ${tradeFlash ? 'v2-trade-flash' : ''}`}>
          <div className="v2-section-title">Open Positions <span className="v2-count">{openTrades?.length || 0}</span></div>
          {resources.trades?.loadedAt == null ? (
            resources.trades?.error
              ? <ErrorState error={resources.trades.error} onRetry={() => retry('trades')} title="Could not load positions" />
              : <LoadingState />
          ) : (!openTrades || openTrades.length === 0) ? (
            <div className="v2-empty">
              <StatusPulse status="idle" size={6} label="No open positions" />
            </div>
          ) : (
            <div className="v2-positions">
              {openTrades.map((t, i) => (
                <PositionCard
                  key={t.id || i}
                  trade={t}
                  curPrice={prices[priceKey(t.symbol)]?.price}
                  isNew={newTradeIds.has(t.id)}
                  onSelect={setSelectedTrade}
                />
              ))}
            </div>
          )}
        </GlowCard>

        {/* Agent Activity */}
        <GlowCard className="v2-section v2-feed-section v2-animate-in v2-stagger-5" padding="0">
          <AgentFeed />
        </GlowCard>

        {/* Last Cycle Report */}
        <GlowCard className="v2-section v2-animate-in v2-stagger-5" padding="0">
          <CycleReport />
        </GlowCard>

        {/* Market Regime */}
        <GlowCard className="v2-section v2-animate-in v2-stagger-6">
          <div className="v2-section-title">Market Regime</div>
          {resources.agents?.loadedAt == null ? (
            resources.agents?.error
              ? <ErrorState error={resources.agents.error} onRetry={() => retry('agents')} title="Could not load regime" />
              : <LoadingState />
          ) : regime.length === 0 ? (
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
            resources.system?.error
              ? <ErrorState error={resources.system.error} onRetry={() => retry('system')} title="Could not load system health" />
              : <LoadingState />
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
          background: var(--v2-bg-hover);
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
          border-radius: var(--v2-radius-sm);
          overflow: hidden;
        }
        .v2-agent-bar-fill {
          height: 100%;
          border-radius: var(--v2-radius-sm);
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

// Market card with its own store selector so only the card whose history changed re-renders
const MarketCard = memo(function MarketCard({ sym, index, price: p }) {
  const sparkData = useDataStore(s => s.priceHistory[sym.key]) || EMPTY_HISTORY;
  const change = p?.change24h ?? 0;
  return (
    <GlowCard
      className={`v2-market-card v2-animate-in v2-stagger-${index + 1}`}
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
        {p
          ? <TickingNumber value={p.price} format="money" decimals={2} colorize={false} />
          : <span className="v2-muted" title="No price yet">{'—'}</span>}
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
});

const EMPTY_HISTORY = [];

const PositionCard = memo(function PositionCard({ trade, curPrice, isNew, onSelect }) {
  const pnlRef = useRef(null);
  const [pulse, setPulse] = useState(null);

  const entry = parseFloat(trade.actual_fill_price || trade.entry_price);
  const qty = parseFloat(trade.quantity);
  const pnl = curPrice > 0 ? (trade.side === 'buy' ? (curPrice - entry) * qty : (entry - curPrice) * qty) : null;
  const pnlPct = pnl != null ? (pnl / (entry * qty)) * 100 : null;
  const sl = parseFloat(trade.sl_price) || 0;
  const tp = parseFloat(trade.tp_price) || 0;

  useEffect(() => {
    if (pnl === null) return undefined;
    const prev = pnlRef.current;
    pnlRef.current = pnl;
    if (prev !== null && pnl !== prev) {
      setPulse(pnl > prev ? 'green' : 'red');
      const timer = setTimeout(() => setPulse(null), 600);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [pnl]);

  const pulseClass = pulse === 'green' ? 'v2-border-pulse-green'
    : pulse === 'red' ? 'v2-border-pulse-red' : '';

  return (
    <div
      className={`v2-position ${pulseClass} ${isNew ? 'v2-slide-in' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Open details for ${trade.symbol || 'position'}`}
      onClick={() => onSelect(trade)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(trade);
        }
      }}
    >
      <div className="v2-pos-header">
        <span className="v2-pos-symbol">{trade.symbol}</span>
        <SignalBadge direction={trade.side === 'buy' ? 'long' : 'short'} />
        <span className="v2-pos-time">{timeAgo(trade.opened_at || trade.created_at)}</span>
      </div>
      <div className="v2-pos-prices">
        <div className="v2-pos-col">
          <span className="v2-pos-label">Entry</span>
          <span className="v2-pos-entry">{fmtMoney(entry)}</span>
        </div>
        <div className="v2-pos-col">
          <span className="v2-pos-label">Current</span>
          {curPrice > 0 ? <TickingNumber value={curPrice} format="money" colorize={false} /> : <span className="v2-muted">--</span>}
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
      {sl > 0 && tp > 0 && curPrice > 0 && (
        <RangeBar
          current={curPrice}
          low={Math.min(sl, tp)}
          high={Math.max(sl, tp)}
          side={trade.side}
        />
      )}
    </div>
  );
});
