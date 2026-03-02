import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function Settings() {
  const [riskLimits, setRiskLimits] = useState(null);
  const [config, setConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [scramHistory, setScramHistory] = useState([]);
  const [bootstrapHistory, setBootstrapHistory] = useState([]);

  const fetchAll = () => {
    Promise.all([
      api('/system/risk-limits'),
      api('/system/config'),
      api('/system/health-detail'),
      api('/system/scram/history'),
      api('/system/bootstrap/history'),
    ]).then(([rl, cfg, h, sh, bh]) => {
      setRiskLimits(rl);
      setConfig(cfg);
      setHealth(h);
      setScramHistory(sh || []);
      setBootstrapHistory(bh || []);
    }).catch(console.error);
  };

  useEffect(() => { fetchAll(); }, []);

  async function activateScram(level) {
    if (!confirm(`Activate SCRAM ${level.toUpperCase()}? This will restrict or halt trading.`)) return;
    await api('/system/scram/activate', { method: 'POST', body: JSON.stringify({ level }), headers: { 'Content-Type': 'application/json' } });
    fetchAll();
  }

  async function clearScram() {
    await api('/system/scram/clear', { method: 'POST' });
    fetchAll();
  }

  if (!riskLimits || !config) {
    return <div className="settings"><div className="empty-state">Loading...</div></div>;
  }

  const limits = riskLimits.limits;
  const graduated = riskLimits.graduated_limits;

  return (
    <div className="settings">
      <h1 className="page-title">SETTINGS</h1>

      <div className="settings-grid">
        {/* Risk Limits */}
        <div className="panel">
          <div className="panel-title">
            Risk Limits
            <span className={`badge badge-${riskLimits.phase}`} style={{ marginLeft: 8, fontSize: 9 }}>
              {riskLimits.phase}
            </span>
          </div>
          <div className="limits-table">
            <LimitRow label="Max Position Size" value={`${limits.MAX_SINGLE_POSITION_PCT}%`} grad={`${graduated.MAX_SINGLE_POSITION_PCT}%`} />
            <LimitRow label="Max Asset Class Exposure" value={`${limits.MAX_ASSET_CLASS_EXPOSURE_PCT}%`} />
            <LimitRow label="Max Correlated Exposure" value={`${limits.MAX_CORRELATED_EXPOSURE_PCT}%`} />
            <LimitRow label="Max Open Positions" value={limits.MAX_OPEN_POSITIONS} grad={graduated.MAX_OPEN_POSITIONS} />
            <LimitRow label="Max Daily Loss" value={`${limits.MAX_DAILY_LOSS_PCT}%`} grad={`${graduated.MAX_DAILY_LOSS_PCT}%`} />
            <LimitRow label="Max Drawdown" value={`${limits.MAX_DRAWDOWN_PCT}%`} />
            <LimitRow label="Max Single Trade Loss" value={`${limits.MAX_SINGLE_TRADE_LOSS_PCT}%`} />
            <LimitRow label="Min Risk/Reward" value={`${limits.MIN_RISK_REWARD_RATIO}:1`} />
            <LimitRow label="Min Confidence" value={`${limits.MIN_CONFIDENCE_TO_TRADE}%`} grad={`${graduated.MIN_CONFIDENCE_TO_TRADE}%`} />
            <LimitRow label="Min Signal Complexity" value={limits.MIN_SIGNAL_COMPLEXITY} />
            <LimitRow label="Event Blackout" value={`${limits.EVENT_BLACKOUT_HOURS}h`} />
            <LimitRow label="Paper Only" value={limits.PAPER_ONLY ? 'Yes' : 'No'} />
          </div>
        </div>

        {/* System Config */}
        <div className="panel">
          <div className="panel-title">System Configuration</div>
          <div className="limits-table">
            <ConfigRow label="Starting Capital" value={`$${config.starting_capital.toLocaleString()}`} />
            <ConfigRow label="Python Engine" value={config.python_engine_url} />
            <ConfigRow label="Cycle Interval" value={config.cycle_interval} />
            <ConfigRow label="Monitor Interval" value={config.monitor_interval} />
            <ConfigRow label="Analysis Every" value={`${config.analysis_every_n_cycles} cycles`} />
            <ConfigRow label="Live Trading" value={config.live_trading ? 'Enabled' : 'Disabled'} highlight={config.live_trading} />
            <ConfigRow label="Micro Trading" value={config.micro_trading ? 'Enabled' : 'Disabled'} />
          </div>
        </div>

        {/* System Status */}
        <div className="panel">
          <div className="panel-title">System Status</div>
          {health && (
            <div className="limits-table">
              <ConfigRow label="Bootstrap Phase" value={health.bootstrap_phase} />
              <ConfigRow label="SCRAM Active" value={health.scram_active ? `Yes (${health.scram_level})` : 'No'} highlight={health.scram_active} />
              <ConfigRow label="Open Trades" value={health.trade_stats?.open_trades} />
              <ConfigRow label="Closed Trades" value={health.trade_stats?.total_closed} />
              <ConfigRow label="Total P&L" value={`$${parseFloat(health.total_pnl || 0).toFixed(2)}`} />
              <ConfigRow label="AI Cost" value={`$${parseFloat(health.total_ai_cost || 0).toFixed(2)}`} />
            </div>
          )}
        </div>

        {/* Agent Models */}
        <div className="panel">
          <div className="panel-title">Agent Models</div>
          <div className="limits-table">
            <ConfigRow label="Knowledge Layer (8)" value="claude-sonnet-4-6" />
            <ConfigRow label="Regime Classifier" value="claude-sonnet-4-6" />
            <ConfigRow label="Synthesizer" value="claude-opus-4-6" />
            <ConfigRow label="Risk Manager" value="claude-sonnet-4-6" />
            <ConfigRow label="Performance Analyst" value="claude-opus-4-6" />
            <ConfigRow label="Pattern Discovery" value="claude-opus-4-6" />
          </div>
        </div>

        {/* SCRAM Controls */}
        <div className="panel">
          <div className="panel-title">SCRAM Controls</div>
          <div className="scram-controls">
            {health?.scram_active ? (
              <div className="scram-active-banner">
                <span className="scram-level-text">SCRAM {health.scram_level?.toUpperCase()} ACTIVE</span>
                <button className="action-btn" onClick={clearScram}>Clear SCRAM</button>
              </div>
            ) : (
              <div className="scram-buttons">
                <button className="scram-btn scram-elevated" onClick={() => activateScram('elevated')}>
                  Elevated
                  <span className="scram-desc">Reduce limits</span>
                </button>
                <button className="scram-btn scram-crisis" onClick={() => activateScram('crisis')}>
                  Crisis
                  <span className="scram-desc">No new trades</span>
                </button>
                <button className="scram-btn scram-emergency" onClick={() => activateScram('emergency')}>
                  Emergency
                  <span className="scram-desc">Close all</span>
                </button>
              </div>
            )}
            {scramHistory.length > 0 && (
              <div className="scram-history">
                <div className="scram-history-title">History</div>
                {scramHistory.slice(0, 5).map((s, i) => (
                  <div key={i} className="scram-history-row">
                    <span className={`badge badge-${s.level === 'emergency' ? 'loss' : s.level === 'crisis' ? 'warn' : 'neutral'}`}>
                      {s.level}
                    </span>
                    <span className="scram-trigger">{s.trigger_name}</span>
                    <span className="scram-time">{new Date(s.activated_at).toLocaleDateString()}</span>
                    <span className="scram-duration">
                      {s.cleared_at ? `${Math.round((s.duration_seconds || 0) / 60)}m` : 'active'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Bootstrap Timeline */}
        <div className="panel">
          <div className="panel-title">Bootstrap Progress</div>
          <div className="bootstrap-timeline">
            {['infant', 'learning', 'maturing', 'graduated'].map((phase, i) => {
              const current = health?.bootstrap_phase || 'infant';
              const phases = ['infant', 'learning', 'maturing', 'graduated'];
              const currentIdx = phases.indexOf(current);
              const isActive = i === currentIdx;
              const isPast = i < currentIdx;
              return (
                <div key={phase} className={`bootstrap-step ${isActive ? 'active' : isPast ? 'past' : 'future'}`}>
                  <div className="bootstrap-dot" />
                  <div className="bootstrap-label">{phase}</div>
                  {isActive && bootstrapHistory[0] && (
                    <div className="bootstrap-meta">
                      {bootstrapHistory[0].total_closed_trades} trades, {bootstrapHistory[0].system_age_days}d
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <style>{`
        .settings { display: flex; flex-direction: column; gap: var(--space-lg); }
        .page-title {
          font-family: 'Syne', sans-serif;
          font-weight: 800;
          font-size: 18px;
          letter-spacing: 6px;
          color: var(--t2);
        }
        .settings-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
          gap: var(--panel-gap);
        }
        .limits-table { display: flex; flex-direction: column; gap: 1px; }
        .limit-row, .config-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--space-sm) 0;
          border-bottom: 1px solid var(--border-0);
        }
        .limit-row:last-child, .config-row:last-child { border-bottom: none; }
        .limit-label, .config-label {
          font-size: 12px;
          color: var(--t2);
        }
        .limit-values { display: flex; align-items: center; gap: var(--space-sm); }
        .limit-value {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13px;
          font-weight: 500;
          color: var(--cyan);
          font-variant-numeric: tabular-nums;
        }
        .limit-grad {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          color: var(--t4);
        }
        .config-value {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          color: var(--t1);
          font-variant-numeric: tabular-nums;
          text-align: right;
          max-width: 220px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .config-value.highlight { color: var(--green); }
        .scram-controls { display: flex; flex-direction: column; gap: var(--space-md); }
        .scram-active-banner {
          display: flex; justify-content: space-between; align-items: center;
          padding: var(--space-md); background: rgba(255,45,85,0.1);
          border: 1px solid rgba(255,45,85,0.3); border-radius: var(--radius-sm);
        }
        .scram-level-text {
          font-family: 'IBM Plex Mono', monospace; font-size: 13px;
          font-weight: 700; color: var(--red); letter-spacing: 2px;
        }
        .scram-buttons { display: flex; gap: var(--space-sm); }
        .scram-btn {
          flex: 1; padding: var(--space-md);
          border: 1px solid var(--border-2); border-radius: var(--radius-sm);
          font-family: 'IBM Plex Mono', monospace; font-size: 11px;
          font-weight: 600; text-transform: uppercase; letter-spacing: 1px;
          display: flex; flex-direction: column; align-items: center; gap: 4px;
          transition: all var(--transition-fast); cursor: pointer;
        }
        .scram-desc { font-size: 9px; font-weight: 400; color: var(--t4); }
        .scram-elevated { color: var(--amber); border-color: rgba(255,179,0,0.3); }
        .scram-elevated:hover { background: rgba(255,179,0,0.08); }
        .scram-crisis { color: var(--red); border-color: rgba(255,45,85,0.3); }
        .scram-crisis:hover { background: rgba(255,45,85,0.08); }
        .scram-emergency { color: #ff0040; border-color: rgba(255,0,64,0.4); }
        .scram-emergency:hover { background: rgba(255,0,64,0.1); }
        .scram-history { margin-top: var(--space-sm); }
        .scram-history-title {
          font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1px; color: var(--t4);
          margin-bottom: var(--space-xs);
        }
        .scram-history-row {
          display: flex; align-items: center; gap: var(--space-sm);
          padding: 3px 0; font-size: 11px;
        }
        .scram-trigger { color: var(--t3); flex: 1; }
        .scram-time { color: var(--t4); font-size: 10px; }
        .scram-duration { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: var(--t3); min-width: 40px; text-align: right; }
        .bootstrap-timeline {
          display: flex; justify-content: space-between; padding: var(--space-md) 0;
          position: relative;
        }
        .bootstrap-timeline::before {
          content: ''; position: absolute; top: 10px; left: 15%;
          width: 70%; height: 2px; background: var(--border-1);
        }
        .bootstrap-step {
          display: flex; flex-direction: column; align-items: center; gap: 6px;
          position: relative; z-index: 1; flex: 1;
        }
        .bootstrap-dot {
          width: 12px; height: 12px; border-radius: 50%;
          border: 2px solid var(--border-2); background: var(--void);
        }
        .bootstrap-step.past .bootstrap-dot { background: var(--cyan); border-color: var(--cyan); }
        .bootstrap-step.active .bootstrap-dot {
          background: var(--cyan); border-color: var(--cyan);
          box-shadow: 0 0 8px rgba(0,229,255,0.5);
        }
        .bootstrap-label {
          font-family: 'IBM Plex Mono', monospace; font-size: 10px;
          text-transform: uppercase; letter-spacing: 0.5px;
        }
        .bootstrap-step.past .bootstrap-label { color: var(--t3); }
        .bootstrap-step.active .bootstrap-label { color: var(--cyan); font-weight: 600; }
        .bootstrap-step.future .bootstrap-label { color: var(--t4); }
        .bootstrap-meta { font-size: 9px; color: var(--t4); }
        .action-btn {
          padding: var(--space-sm) var(--space-lg);
          border: 1px solid var(--border-2); border-radius: var(--radius-sm);
          font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 0.5px; color: var(--t2);
          transition: all var(--transition-fast); cursor: pointer;
        }
        .action-btn:hover { border-color: var(--cyan); color: var(--cyan); }
      `}</style>
    </div>
  );
}

function LimitRow({ label, value, grad }) {
  return (
    <div className="limit-row">
      <span className="limit-label">{label}</span>
      <div className="limit-values">
        <span className="limit-value">{value}</span>
        {grad != null && grad !== value && (
          <span className="limit-grad">(grad: {grad})</span>
        )}
      </div>
    </div>
  );
}

function ConfigRow({ label, value, highlight }) {
  return (
    <div className="config-row">
      <span className="config-label">{label}</span>
      <span className={`config-value ${highlight ? 'highlight' : ''}`}>{value}</span>
    </div>
  );
}
