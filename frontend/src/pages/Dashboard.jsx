import { useEffect, useState } from 'react';
import { useDataStore } from '../stores/data';
import KPIBar from '../components/KPIBar';
import Chart from '../components/Chart';
import EquityCurve from '../components/EquityCurve';
import AgentFeed from '../components/AgentFeed';
import TradeDetail from '../components/TradeDetail';
import EventCalendar from '../components/EventCalendar';
import { formatMoney, timeAgo } from '../lib/format';

export default function Dashboard() {
  const { fetchPortfolio, fetchAgents, fetchSignals, fetchTrades, fetchSystem, fetchPrices,
    triggerCycle, refreshData, signals, regime, openTrades, lastCycle, system } = useDataStore();
  const [selectedTrade, setSelectedTrade] = useState(null);

  useEffect(() => {
    fetchPortfolio();
    fetchAgents();
    fetchSignals();
    fetchTrades();
    fetchSystem();
    fetchPrices();
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
              <span className={`badge badge-${r.regime?.includes('up') ? 'profit' : r.regime?.includes('down') ? 'loss' : 'neutral'}`}>
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
                  <span className={`badge badge-${s.direction === 'bullish' ? 'profit' : s.direction === 'bearish' ? 'loss' : 'neutral'}`}>
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
              {openTrades.map((t, i) => (
                <div key={i} className="position-row clickable" onClick={() => setSelectedTrade(t)}>
                  <span className="pos-symbol">{t.symbol}</span>
                  <span className={`badge badge-${t.side === 'buy' ? 'profit' : 'loss'}`}>
                    {t.side === 'buy' ? 'LONG' : 'SHORT'}
                  </span>
                  <span className="num">{formatMoney(parseFloat(t.entry_price))}</span>
                  <span className="pos-time">{timeAgo(t.opened_at || t.created_at)}</span>
                </div>
              ))}
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
                  <div className="cycle-row">
                    <span className="cycle-label">Proposals</span>
                    <span className="num">{lastCycle.strategy.proposals}</span>
                  </div>
                  <div className="cycle-row">
                    <span className="cycle-label">Approved</span>
                    <span className="num profit">{lastCycle.strategy.approved}</span>
                  </div>
                  <div className="cycle-row">
                    <span className="cycle-label">Rejected</span>
                    <span className="num loss">{lastCycle.strategy.rejected}</span>
                  </div>
                  <div className="cycle-row">
                    <span className="cycle-label">Executed</span>
                    <span className="num">{lastCycle.strategy.trades}</span>
                  </div>
                </>
              )}
              {lastCycle.agents?.map((a, i) => (
                <div key={i} className="cycle-row">
                  <span className="cycle-label">{a.agent}</span>
                  <span className={`badge badge-${a.status === 'fulfilled' ? 'profit' : 'loss'}`}>
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
                <span className="num">{system.trade_stats?.total_closed || 0}</span>
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
      `}</style>
    </div>
  );
}
