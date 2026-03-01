import { useEffect, useState } from 'react';
import { useDataStore } from '../stores/data';
import KPIBar from '../components/KPIBar';
import Chart from '../components/Chart';
import EquityCurve from '../components/EquityCurve';
import AgentFeed from '../components/AgentFeed';
import TradeDetail from '../components/TradeDetail';
import EventCalendar from '../components/EventCalendar';
import { formatMoney, formatPct, formatPrice, timeAgo } from '../lib/format';

export default function Dashboard() {
  const fetchPortfolio = useDataStore(s => s.fetchPortfolio);
  const fetchAgents = useDataStore(s => s.fetchAgents);
  const fetchSignals = useDataStore(s => s.fetchSignals);
  const fetchTrades = useDataStore(s => s.fetchTrades);
  const fetchSystem = useDataStore(s => s.fetchSystem);
  const fetchPrices = useDataStore(s => s.fetchPrices);
  const triggerCycle = useDataStore(s => s.triggerCycle);
  const refreshData = useDataStore(s => s.refreshData);
  const signals = useDataStore(s => s.signals);
  const regime = useDataStore(s => s.regime);
  const openTrades = useDataStore(s => s.openTrades);
  const lastCycle = useDataStore(s => s.lastCycle);
  const system = useDataStore(s => s.system);
  const prices = useDataStore(s => s.prices);
  const [selectedTrade, setSelectedTrade] = useState(null);

  useEffect(() => {
    fetchPortfolio();
    fetchAgents();
    fetchSignals();
    fetchTrades();
    fetchSystem();
    fetchPrices();

    // Poll prices every 30s for live P&L updates
    const priceInterval = setInterval(fetchPrices, 30_000);
    return () => clearInterval(priceInterval);
  }, []);

  return (
    <div className="dashboard">
      <div className="page-header">
        <h1 className="page-title">COMMAND CENTRE</h1>
        <div className="header-actions">
          <button className="action-btn" onClick={() => refreshData().then(() => alert('Data refreshed')).catch(e => alert('Error: ' + e.message))}>Refresh Data</button>
          <button className="action-btn primary" onClick={() => triggerCycle().then(() => alert('Cycle started')).catch(e => alert('Error: ' + e.message))}>Run Cycle</button>
        </div>
      </div>

      <KPIBar />

      <Chart />
      <EquityCurve />

      <div className="dashboard-grid">
        {/* Regime & Status */}
        <div className="panel">
          <div className="panel-title">Market Regime</div>
          {regime.length === 0 ? (
            <div className="empty-state">No regime data yet</div>
          ) : regime.map((r, i) => (
            <div key={i} className="regime-row">
              <span className="regime-class">{r.asset_class}</span>
              <span className={`badge badge-${r.regime?.includes('up') ? 'maturing' : r.regime?.includes('down') ? 'warn' : 'neutral'}`}>
                {r.regime}
              </span>
              {r.sub_regime && <span className="regime-sub">{r.sub_regime}</span>}
              <span className="num regime-conf">{r.confidence}%</span>
            </div>
          ))}
        </div>

        {/* Active Signals */}
        <div className="panel">
          <div className="panel-title">Active Signals ({signals.length})</div>
          {signals.length === 0 ? (
            <div className="empty-state">No active signals</div>
          ) : (
            <div className="signal-list">
              {signals.slice(0, 10).map((s, i) => (
                <div key={i} className="signal-row">
                  <span className="signal-symbol">{s.symbol}</span>
                  <span className={`badge badge-${s.direction === 'bullish' ? 'bullish' : s.direction === 'bearish' ? 'bearish' : 'neutral'}`}>
                    {s.direction}
                  </span>
                  <span className="signal-type">{s.signal_type}</span>
                  <span className="num signal-strength">{Math.round(s.current_strength || s.strength)}</span>
                  <span className="signal-agent">{s.agent_name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Open Positions */}
        <div className="panel">
          <div className="panel-title">Open Positions ({openTrades.length})</div>
          {openTrades.length === 0 ? (
            <div className="empty-state">No open positions</div>
          ) : (
            <div className="positions-list">
              {openTrades.map((t, i) => {
                const entry = parseFloat(t.actual_fill_price || t.entry_price);
                const qty = parseFloat(t.quantity);
                const dashSymbol = t.symbol.replace('/', '-');
                const curPrice = prices[dashSymbol]?.price;
                const pnl = curPrice ? (t.side === 'buy' ? (curPrice - entry) * qty : (entry - curPrice) * qty) : null;
                const pnlPct = pnl != null ? (pnl / (entry * qty)) * 100 : null;
                return (
                  <div key={i} className="position-row clickable" onClick={() => setSelectedTrade(t)}>
                    <span className="pos-symbol">{t.symbol}</span>
                    <span className={`badge badge-${t.side === 'buy' ? 'profit' : 'loss'}`}>
                      {t.side === 'buy' ? 'LONG' : 'SHORT'}
                    </span>
                    {formatPrice(entry)}
                    {pnl != null ? (
                      <>
                        <span className="pos-pnl">{formatMoney(pnl)}</span>
                        <span className="pos-pnl">{formatPct(pnlPct, 2)}</span>
                      </>
                    ) : (
                      <span className="pos-pnl" style={{ color: 'var(--t4)' }}>—</span>
                    )}
                    <span className="pos-time">{timeAgo(t.opened_at || t.created_at)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Agent Feed */}
        <AgentFeed />

        {/* Last Cycle */}
        <div className="panel">
          <div className="panel-title">Last Cycle</div>
          {!lastCycle ? (
            <div className="empty-state">No cycles run yet</div>
          ) : (
            <div className="cycle-info">
              <div className="cycle-row">
                <span className="cycle-label">Cycle</span>
                <span className="num">{lastCycle.cycleNumber}</span>
              </div>
              <div className="cycle-row">
                <span className="cycle-label">Duration</span>
                <span className="num">{lastCycle.elapsed}</span>
              </div>
              {lastCycle.strategy && (
                <>
                  {lastCycle.strategy.proposals > 0 && (
                    <div className="cycle-row">
                      <span className="cycle-label">Proposals</span>
                      <span className="num">{lastCycle.strategy.proposals}</span>
                    </div>
                  )}
                  {lastCycle.strategy.approved > 0 && (
                    <div className="cycle-row">
                      <span className="cycle-label">Approved</span>
                      <span className="num profit">{lastCycle.strategy.approved}</span>
                    </div>
                  )}
                  {lastCycle.strategy.rejected > 0 && (
                    <div className="cycle-row">
                      <span className="cycle-label">Rejected</span>
                      <span className="num loss">{lastCycle.strategy.rejected}</span>
                    </div>
                  )}
                  {lastCycle.strategy.trades > 0 && (
                    <div className="cycle-row">
                      <span className="cycle-label">Executed</span>
                      <span className="num">{lastCycle.strategy.trades}</span>
                    </div>
                  )}
                  {lastCycle.strategy.standing_orders > 0 && (
                    <div className="cycle-row">
                      <span className="cycle-label">Standing Orders</span>
                      <span className="badge badge-ai">{lastCycle.strategy.standing_orders} placed</span>
                    </div>
                  )}
                  {lastCycle.strategy.proposals === 0 && (
                    <div className="cycle-status-line">
                      {lastCycle.strategy.standing_orders > 0
                        ? 'Waiting for trigger prices'
                        : 'No entries — regime unfavorable'}
                    </div>
                  )}
                </>
              )}
              {lastCycle.agents?.map((a, i) => (
                <div key={i} className="cycle-row">
                  <span className="cycle-label">{a.agent}</span>
                  <span className={`badge badge-${a.status === 'fulfilled' ? 'ai' : 'loss'}`}>
                    {a.status === 'fulfilled' ? `${a.signals} signals` : 'failed'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* System Health */}
        <div className="panel">
          <div className="panel-title">System Health</div>
          {!system ? (
            <div className="empty-state">Loading...</div>
          ) : (
            <div className="system-info">
              <div className="cycle-row">
                <span className="cycle-label">Bootstrap</span>
                <span className={`badge badge-${system.bootstrap_phase}`}>{system.bootstrap_phase}</span>
              </div>
              <div className="cycle-row">
                <span className="cycle-label">Total Trades</span>
                <span className="num">{system.trade_stats?.total_trades || 0}</span>
              </div>
              <div className="cycle-row">
                <span className="cycle-label">Win Rate</span>
                <span className="num">{system.trade_stats?.win_rate || 0}%</span>
              </div>
            </div>
          )}
        </div>

        {/* Event Calendar */}
        <EventCalendar />
      </div>

      <TradeDetail
        trade={selectedTrade}
        open={!!selectedTrade}
        onClose={() => setSelectedTrade(null)}
      />

      <style>{`
        .dashboard { display: flex; flex-direction: column; gap: var(--space-lg); }
        .page-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .page-title {
          font-family: 'Syne', sans-serif;
          font-weight: 800;
          font-size: 18px;
          letter-spacing: 6px;
          color: var(--t2);
        }
        .header-actions { display: flex; gap: var(--space-sm); }
        .action-btn {
          padding: var(--space-sm) var(--space-lg);
          border: 1px solid var(--border-2);
          border-radius: var(--radius-sm);
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--t2);
          transition: all var(--transition-fast);
        }
        .action-btn:hover { border-color: var(--cyan); color: var(--cyan); }
        .action-btn.primary {
          background: var(--cyan);
          color: var(--void);
          border-color: var(--cyan);
        }
        .action-btn.primary:hover { opacity: 0.9; }
        .dashboard-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
          gap: var(--panel-gap);
        }
        .empty-state {
          color: var(--t4);
          font-size: 13px;
          padding: var(--space-xl);
          text-align: center;
        }
        .regime-row, .signal-row, .position-row, .cycle-row {
          display: flex;
          align-items: center;
          gap: var(--space-sm);
          padding: var(--space-xs) 0;
        }
        .regime-class, .signal-symbol, .pos-symbol {
          font-family: 'IBM Plex Mono', monospace;
          font-weight: 500;
          font-size: 12px;
          min-width: 60px;
        }
        .regime-sub { color: var(--t3); font-size: 12px; }
        .regime-conf { color: var(--t3); font-size: 11px; margin-left: auto; }
        .signal-type {
          font-size: 11px;
          color: var(--t3);
          flex: 1;
        }
        .signal-strength { color: var(--cyan); font-size: 12px; }
        .signal-agent {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 9px;
          color: var(--ai);
          text-transform: uppercase;
        }
        .pos-time { color: var(--t4); font-size: 11px; margin-left: auto; }
        .clickable { cursor: pointer; }
        .cycle-label {
          font-size: 12px;
          color: var(--t3);
          flex: 1;
        }
        .cycle-info, .system-info { display: flex; flex-direction: column; gap: 2px; }
        .cycle-status-line {
          font-size: 12px;
          color: var(--t4);
          font-style: italic;
          padding: var(--space-xs) 0;
        }
        .badge-bullish { color: var(--cyan); background: rgba(0,229,255,0.10); }
        .badge-bearish { color: var(--warn); background: rgba(255,184,0,0.10); }
        .badge-maturing { color: var(--green); background: rgba(0,255,136,0.10); }
      `}</style>
    </div>
  );
}
