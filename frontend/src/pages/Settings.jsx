import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { GlowCard, StatusPulse } from '../components/ui';

export default function Settings() {
  const [riskLimits, setRiskLimits] = useState(null);
  const [config, setConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [scramHistory, setScramHistory] = useState([]);
  const [bootstrapHistory, setBootstrapHistory] = useState([]);
  const [correlations, setCorrelations] = useState(null);
  const [readiness, setReadiness] = useState(null);

  const fetchAll = () => {
    Promise.all([
      api('/system/risk-limits'),
      api('/system/config'),
      api('/system/health-detail'),
      api('/system/scram/history'),
      api('/system/bootstrap/history'),
      api('/correlations').catch(() => null),
      api('/system/readiness').catch(() => null),
    ]).then(([rl, cfg, h, sh, bh, corr, rd]) => {
      setRiskLimits(rl);
      setConfig(cfg);
      setHealth(h);
      setScramHistory(sh || []);
      setBootstrapHistory(bh || []);
      setCorrelations(corr);
      setReadiness(rd);
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
    return <div className="v2-settings"><div className="v2-empty">Loading...</div></div>;
  }

  const limits = riskLimits.limits;
  const graduated = riskLimits.graduated_limits;
  const phases = ['infant', 'learning', 'maturing', 'graduated'];
  const currentPhase = health?.bootstrap_phase || 'infant';
  const currentIdx = phases.indexOf(currentPhase);

  // Service health checks — Node is always up if this page rendered; others from health-detail
  const services = [
    { name: 'Node.js', status: 'active', detail: `Port ${config.port || 3100}` },
    { name: 'Python Engine', status: !health ? 'idle' : health.python_engine ? 'active' : 'error', detail: config.python_engine_url },
    { name: 'PostgreSQL', status: !health ? 'idle' : health.database ? 'active' : 'error', detail: health?.database ? 'Connected' : 'Unreachable' },
  ];

  return (
    <div className="v2-settings">
      <h1 className="v2-page-title v2-animate-in">SETTINGS</h1>

      {/* Service Status Bar */}
      <div className="v2-services-bar v2-animate-in v2-stagger-1">
        {services.map((svc) => (
          <div key={svc.name} className="v2-service-item">
            <StatusPulse status={svc.status} size={7} />
            <span className="v2-service-name">{svc.name}</span>
            <span className="v2-service-detail">{svc.detail}</span>
          </div>
        ))}
      </div>

      <div className="v2-settings-grid">
        {/* Live Trading Readiness */}
        <div className="v2-animate-in v2-stagger-1b">
          <GlowCard glowColor={readiness?.ready ? 'green' : 'red'}>
            <div className="v2-section-title">Live Trading Readiness</div>
            {readiness ? (
              <div className="v2-readiness">
                <div className={`v2-readiness-banner ${readiness.ready ? 'v2-readiness--pass' : 'v2-readiness--fail'}`}>
                  <StatusPulse status={readiness.ready ? 'active' : 'error'} size={8} />
                  <span className="v2-readiness-status">
                    {readiness.ready
                      ? 'READY FOR LIVE TRADING'
                      : `NOT READY — ${readiness.conditions.filter(c => !c.passed).length} CONDITION${readiness.conditions.filter(c => !c.passed).length !== 1 ? 'S' : ''} FAILING`
                    }
                  </span>
                </div>
                <div className="v2-readiness-checks">
                  {readiness.conditions.map(c => (
                    <div key={c.key} className={`v2-readiness-row ${c.passed ? 'v2-readiness-row--pass' : 'v2-readiness-row--fail'}`}>
                      <span className="v2-readiness-icon">{c.passed ? '\u2713' : '\u2715'}</span>
                      <span className="v2-readiness-label">{c.label}</span>
                      <span className="v2-readiness-values">
                        <span className="v2-readiness-current">{c.current}</span>
                        <span className="v2-readiness-sep">/</span>
                        <span className="v2-readiness-required">{c.required}</span>
                      </span>
                    </div>
                  ))}
                </div>
                <div
                  className={`v2-live-toggle ${readiness.ready ? '' : 'v2-live-toggle--disabled'}`}
                  title={readiness.ready ? '' : 'Complete all readiness conditions first'}
                >
                  <span className="v2-live-toggle-label">Live Trading</span>
                  <span className={`v2-live-toggle-value ${config?.live_trading ? 'v2-live-toggle--on' : ''}`}>
                    {config?.live_trading ? 'ENABLED' : 'DISABLED'}
                  </span>
                </div>
              </div>
            ) : (
              <div className="v2-empty" style={{ padding: 'var(--v2-space-md) 0' }}>Loading readiness data...</div>
            )}
          </GlowCard>
        </div>

        {/* SCRAM Controls */}
        <div className="v2-animate-in v2-stagger-2">
          <GlowCard glowColor="red">
            <div className="v2-section-title">SCRAM Controls</div>
            <div className="v2-scram-controls">
              {health?.scram_active ? (
                <div className="v2-scram-active-banner">
                  <div className="v2-scram-active-left">
                    <StatusPulse status="error" size={8} />
                    <span className="v2-scram-level-text">SCRAM {health.scram_level?.toUpperCase()} ACTIVE</span>
                  </div>
                  <button className="v2-action-btn" onClick={clearScram}>Clear SCRAM</button>
                </div>
              ) : (
                <div className="v2-scram-buttons">
                  <button className="v2-scram-btn v2-scram-elevated" onClick={() => activateScram('elevated')}>
                    Elevated
                    <span className="v2-scram-desc">Reduce limits</span>
                  </button>
                  <button className="v2-scram-btn v2-scram-crisis" onClick={() => activateScram('crisis')}>
                    Crisis
                    <span className="v2-scram-desc">No new trades</span>
                  </button>
                  <button className="v2-scram-btn v2-scram-emergency" onClick={() => activateScram('emergency')}>
                    Emergency
                    <span className="v2-scram-desc">Close all</span>
                  </button>
                </div>
              )}
              {scramHistory.length > 0 && (
                <div className="v2-scram-history">
                  <div className="v2-scram-history-title">History</div>
                  {scramHistory.slice(0, 5).map((s, i) => (
                    <div key={i} className="v2-scram-history-row">
                      <StatusPulse
                        status={s.level === 'emergency' ? 'error' : s.level === 'crisis' ? 'warning' : 'idle'}
                        size={5}
                        label={s.level}
                      />
                      <span className="v2-scram-trigger">{s.trigger_name}</span>
                      <span className="v2-scram-time">{new Date(s.activated_at).toLocaleDateString()}</span>
                      <span className="v2-scram-duration">
                        {s.cleared_at ? `${Math.round((s.duration_seconds || 0) / 60)}m` : 'active'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </GlowCard>
        </div>

        {/* Bootstrap Timeline */}
        <div className="v2-animate-in v2-stagger-3">
          <GlowCard glowColor="cyan">
            <div className="v2-section-title">Bootstrap Progress</div>
            <div className="v2-bootstrap-timeline">
              {phases.map((phase, i) => {
                const isActive = i === currentIdx;
                const isPast = i < currentIdx;
                return (
                  <div key={phase} className={`v2-bootstrap-step ${isActive ? 'active' : isPast ? 'past' : 'future'}`}>
                    <div className="v2-bootstrap-dot">
                      {isActive && <div className="v2-bootstrap-pulse" />}
                    </div>
                    <div className="v2-bootstrap-label">{phase}</div>
                    {isActive && bootstrapHistory[0] && (
                      <div className="v2-bootstrap-meta">
                        {bootstrapHistory[0].total_closed_trades} trades, {bootstrapHistory[0].system_age_days}d
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Progress bar */}
            <div className="v2-bootstrap-progress-track">
              <div className="v2-bootstrap-progress-fill" style={{ width: `${((currentIdx + 1) / phases.length) * 100}%` }} />
            </div>
          </GlowCard>
        </div>

        {/* Risk Limits */}
        <div className="v2-animate-in v2-stagger-4">
          <GlowCard>
            <div className="v2-section-header">
              <span className="v2-section-title">Risk Limits</span>
              <StatusPulse
                status={riskLimits.phase === 'graduated' ? 'active' : 'warning'}
                size={6}
                label={riskLimits.phase}
              />
            </div>
            <div className="v2-limits-table">
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
          </GlowCard>
        </div>

        {/* Correlation Matrix */}
        <div className="v2-animate-in v2-stagger-5">
          <GlowCard>
            <div className="v2-section-title">Correlation Matrix (30d)</div>
            {correlations ? (
              <CorrelationMatrix correlations={correlations} />
            ) : (
              <div className="v2-empty" style={{ padding: 'var(--v2-space-md) 0' }}>No correlation data yet</div>
            )}
          </GlowCard>
        </div>

        {/* System Config */}
        <div className="v2-animate-in v2-stagger-6">
          <GlowCard>
            <div className="v2-section-title">System Configuration</div>
            <div className="v2-limits-table">
              <ConfigRow label="Starting Capital" value={`$${config.starting_capital.toLocaleString()}`} />
              <ConfigRow label="Python Engine" value={config.python_engine_url} />
              <ConfigRow label="Cycle Interval" value={config.cycle_interval} />
              <ConfigRow label="Monitor Interval" value={config.monitor_interval} />
              <ConfigRow label="Analysis Every" value={`${config.analysis_every_n_cycles} cycles`} />
              <ConfigRow label="Live Trading" value={config.live_trading ? 'Enabled' : 'Disabled'} highlight={config.live_trading} />
              <ConfigRow label="Micro Trading" value={config.micro_trading ? 'Enabled' : 'Disabled'} />
            </div>
          </GlowCard>
        </div>

        {/* System Status */}
        <div className="v2-animate-in v2-stagger-7">
          <GlowCard>
            <div className="v2-section-title">System Status</div>
            {health && (
              <div className="v2-limits-table">
                <ConfigRow label="Bootstrap Phase" value={health.bootstrap_phase} />
                <ConfigRow label="SCRAM Active" value={health.scram_active ? `Yes (${health.scram_level})` : 'No'} highlight={health.scram_active} />
                <ConfigRow label="Open Trades" value={health.trade_stats?.open_trades} />
                <ConfigRow label="Closed Trades" value={health.trade_stats?.total_closed} />
                <ConfigRow label="Total P&L" value={`$${parseFloat(health.total_pnl || 0).toFixed(2)}`} />
                <ConfigRow label="AI Cost" value={`$${parseFloat(health.total_ai_cost || 0).toFixed(2)}`} />
              </div>
            )}
          </GlowCard>
        </div>

        {/* Agent Models */}
        <div className="v2-animate-in v2-stagger-8">
          <GlowCard>
            <div className="v2-section-title">Agent Models</div>
            <div className="v2-limits-table">
              <ConfigRow label="Knowledge Layer (8)" value="claude-sonnet-4-6" />
              <ConfigRow label="Regime Classifier" value="claude-sonnet-4-6" />
              <ConfigRow label="Synthesizer" value="claude-opus-4-6" />
              <ConfigRow label="Risk Manager" value="claude-sonnet-4-6" />
              <ConfigRow label="Performance Analyst" value="claude-opus-4-6" />
              <ConfigRow label="Pattern Discovery" value="claude-opus-4-6" />
            </div>
          </GlowCard>
        </div>
      </div>

      <style>{`
        .v2-settings { display: flex; flex-direction: column; gap: var(--v2-space-lg); }
        .v2-page-title {
          font-family: 'Syne', sans-serif; font-weight: 800; font-size: 20px;
          letter-spacing: 6px; color: var(--v2-text-primary);
        }
        .v2-section-title {
          font-family: var(--v2-font-data); font-size: 11px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1.5px; color: var(--v2-text-muted);
          margin-bottom: var(--v2-space-md);
        }
        .v2-section-header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: var(--v2-space-md);
        }
        .v2-section-header .v2-section-title { margin-bottom: 0; }
        .v2-settings-grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
          gap: var(--v2-space-lg);
        }
        .v2-empty { color: var(--v2-text-muted); font-size: 13px; padding: var(--v2-space-xl); text-align: center; }

        /* Service Status Bar */
        .v2-services-bar {
          display: flex; gap: var(--v2-space-lg);
          padding: var(--v2-space-md) var(--v2-space-lg);
          background: var(--v2-glass-bg);
          backdrop-filter: var(--v2-glass-blur);
          border: 1px solid var(--v2-border);
          border-radius: var(--v2-radius-sm);
        }
        .v2-service-item {
          display: flex; align-items: center; gap: var(--v2-space-sm);
        }
        .v2-service-name {
          font-family: var(--v2-font-data); font-size: 11px; font-weight: 600;
          color: var(--v2-text-primary); text-transform: uppercase; letter-spacing: 0.5px;
        }
        .v2-service-detail {
          font-family: var(--v2-font-data); font-size: 10px;
          color: var(--v2-text-muted);
        }

        /* Limit / Config rows */
        .v2-limits-table { display: flex; flex-direction: column; gap: 1px; }
        .v2-limit-row, .v2-config-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: var(--v2-space-sm) 0; border-bottom: 1px solid var(--v2-border);
        }
        .v2-limit-row:last-child, .v2-config-row:last-child { border-bottom: none; }
        .v2-limit-label, .v2-config-label {
          font-size: 12px; color: var(--v2-text-secondary);
        }
        .v2-limit-values { display: flex; align-items: center; gap: var(--v2-space-sm); }
        .v2-limit-value {
          font-family: var(--v2-font-data); font-size: 13px; font-weight: 500;
          color: var(--v2-accent-cyan); font-variant-numeric: tabular-nums;
        }
        .v2-limit-grad {
          font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-text-muted);
        }
        .v2-config-value {
          font-family: var(--v2-font-data); font-size: 12px;
          color: var(--v2-text-primary); font-variant-numeric: tabular-nums;
          text-align: right; max-width: 220px;
          overflow: hidden; text-overflow: ellipsis;
        }
        .v2-config-value.highlight { color: var(--v2-accent-green); }

        /* SCRAM */
        .v2-scram-controls { display: flex; flex-direction: column; gap: var(--v2-space-md); }
        .v2-scram-active-banner {
          display: flex; justify-content: space-between; align-items: center;
          padding: var(--v2-space-md); background: rgba(239,83,80,0.08);
          border: 1px solid rgba(239,83,80,0.25); border-radius: var(--v2-radius-sm);
          animation: v2-scram-glow 2s ease-in-out infinite;
        }
        @keyframes v2-scram-glow {
          0%, 100% { box-shadow: 0 0 15px rgba(239,83,80,0.15); }
          50% { box-shadow: 0 0 30px rgba(239,83,80,0.3); }
        }
        .v2-scram-active-left { display: flex; align-items: center; gap: var(--v2-space-sm); }
        .v2-scram-level-text {
          font-family: var(--v2-font-data); font-size: 13px;
          font-weight: 700; color: var(--v2-accent-red); letter-spacing: 2px;
        }
        .v2-action-btn {
          padding: var(--v2-space-sm) var(--v2-space-lg);
          border: 1px solid var(--v2-border-hover); border-radius: var(--v2-radius-sm);
          font-family: var(--v2-font-data); font-size: 11px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 0.5px; color: var(--v2-text-secondary);
          transition: all var(--v2-duration-fast); background: transparent; cursor: pointer;
        }
        .v2-action-btn:hover { border-color: var(--v2-accent-cyan); color: var(--v2-accent-cyan); }
        .v2-scram-buttons { display: flex; gap: var(--v2-space-sm); }
        .v2-scram-btn {
          flex: 1; padding: var(--v2-space-md);
          border: 1px solid var(--v2-border-hover); border-radius: var(--v2-radius-sm);
          font-family: var(--v2-font-data); font-size: 11px;
          font-weight: 600; text-transform: uppercase; letter-spacing: 1px;
          display: flex; flex-direction: column; align-items: center; gap: 4px;
          transition: all var(--v2-duration-fast); cursor: pointer; background: transparent;
        }
        .v2-scram-desc { font-size: 9px; font-weight: 400; color: var(--v2-text-muted); }
        .v2-scram-elevated { color: var(--v2-accent-amber); border-color: rgba(255,171,0,0.3); }
        .v2-scram-elevated:hover { background: rgba(255,171,0,0.06); box-shadow: 0 0 20px rgba(255,171,0,0.15); }
        .v2-scram-crisis { color: var(--v2-accent-red); border-color: rgba(239,83,80,0.3); }
        .v2-scram-crisis:hover { background: rgba(239,83,80,0.06); box-shadow: 0 0 20px rgba(239,83,80,0.15); }
        .v2-scram-emergency { color: var(--v2-accent-red); border-color: rgba(239,83,80,0.4); }
        .v2-scram-emergency:hover { background: rgba(239,83,80,0.08); box-shadow: 0 0 20px rgba(239,83,80,0.2); }
        .v2-scram-history { margin-top: var(--v2-space-sm); }
        .v2-scram-history-title {
          font-family: var(--v2-font-data); font-size: 9px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1px; color: var(--v2-text-muted);
          margin-bottom: var(--v2-space-xs);
        }
        .v2-scram-history-row {
          display: flex; align-items: center; gap: var(--v2-space-sm);
          padding: 3px 0; font-size: 11px;
        }
        .v2-scram-trigger { color: var(--v2-text-secondary); flex: 1; }
        .v2-scram-time { color: var(--v2-text-muted); font-size: 10px; }
        .v2-scram-duration {
          font-family: var(--v2-font-data); font-size: 10px;
          color: var(--v2-text-secondary); min-width: 40px; text-align: right;
        }

        /* Bootstrap Timeline */
        .v2-bootstrap-timeline {
          display: flex; justify-content: space-between; padding: var(--v2-space-lg) 0;
          position: relative;
        }
        .v2-bootstrap-timeline::before {
          content: ''; position: absolute; top: 30px; left: 15%;
          width: 70%; height: 2px; background: var(--v2-border);
        }
        .v2-bootstrap-step {
          display: flex; flex-direction: column; align-items: center; gap: 6px;
          position: relative; z-index: 1; flex: 1;
        }
        .v2-bootstrap-dot {
          width: 14px; height: 14px; border-radius: 50%;
          border: 2px solid var(--v2-border-hover); background: var(--v2-bg-primary);
          position: relative;
        }
        .v2-bootstrap-step.past .v2-bootstrap-dot {
          background: var(--v2-accent-cyan); border-color: var(--v2-accent-cyan);
        }
        .v2-bootstrap-step.active .v2-bootstrap-dot {
          background: var(--v2-accent-cyan); border-color: var(--v2-accent-cyan);
          box-shadow: 0 0 12px rgba(79,195,247,0.5);
        }
        .v2-bootstrap-pulse {
          position: absolute; inset: -4px; border-radius: 50%;
          border: 1px solid var(--v2-accent-cyan);
          animation: v2-status-pulse 2s ease-in-out infinite;
        }
        .v2-bootstrap-label {
          font-family: var(--v2-font-data); font-size: 10px;
          text-transform: uppercase; letter-spacing: 0.5px;
        }
        .v2-bootstrap-step.past .v2-bootstrap-label { color: var(--v2-text-secondary); }
        .v2-bootstrap-step.active .v2-bootstrap-label { color: var(--v2-accent-cyan); font-weight: 600; }
        .v2-bootstrap-step.future .v2-bootstrap-label { color: var(--v2-text-muted); }
        .v2-bootstrap-meta { font-size: 9px; color: var(--v2-text-muted); }
        .v2-bootstrap-progress-track {
          height: 3px; background: var(--v2-border); border-radius: 2px;
          overflow: hidden; margin-top: var(--v2-space-xs);
        }
        .v2-bootstrap-progress-fill {
          height: 100%; background: var(--v2-accent-cyan);
          border-radius: 2px; transition: width 0.5s ease;
          box-shadow: 0 0 8px rgba(79,195,247,0.4);
        }

        /* Readiness Gate */
        .v2-readiness { display: flex; flex-direction: column; gap: var(--v2-space-md); }
        .v2-readiness-banner {
          display: flex; align-items: center; gap: var(--v2-space-sm);
          padding: var(--v2-space-md); border-radius: var(--v2-radius-sm);
        }
        .v2-readiness--pass {
          background: rgba(102, 187, 106, 0.08);
          border: 1px solid rgba(102, 187, 106, 0.25);
          box-shadow: 0 0 20px rgba(102, 187, 106, 0.1);
        }
        .v2-readiness--fail {
          background: rgba(239, 83, 80, 0.06);
          border: 1px solid rgba(239, 83, 80, 0.2);
        }
        .v2-readiness-status {
          font-family: var(--v2-font-data); font-size: 12px;
          font-weight: 700; letter-spacing: 1.5px;
        }
        .v2-readiness--pass .v2-readiness-status { color: var(--v2-accent-green); }
        .v2-readiness--fail .v2-readiness-status { color: var(--v2-accent-red); }
        .v2-readiness-checks { display: flex; flex-direction: column; gap: 2px; }
        .v2-readiness-row {
          display: flex; align-items: center; gap: var(--v2-space-sm);
          padding: var(--v2-space-sm) var(--v2-space-sm);
          border-radius: var(--v2-radius-sm);
        }
        .v2-readiness-row--pass { }
        .v2-readiness-row--fail { background: rgba(239, 83, 80, 0.04); }
        .v2-readiness-icon {
          font-size: 12px; width: 18px; text-align: center; flex-shrink: 0;
        }
        .v2-readiness-row--pass .v2-readiness-icon { color: var(--v2-accent-green); }
        .v2-readiness-row--fail .v2-readiness-icon { color: var(--v2-accent-red); }
        .v2-readiness-label {
          font-size: 12px; color: var(--v2-text-secondary); flex: 1;
        }
        .v2-readiness-values {
          display: flex; align-items: center; gap: 4px;
          font-family: var(--v2-font-data); font-size: 12px;
          font-variant-numeric: tabular-nums;
        }
        .v2-readiness-row--pass .v2-readiness-current { color: var(--v2-accent-green); font-weight: 600; }
        .v2-readiness-row--fail .v2-readiness-current { color: var(--v2-accent-red); font-weight: 600; }
        .v2-readiness-sep { color: var(--v2-text-muted); }
        .v2-readiness-required { color: var(--v2-text-muted); font-size: 11px; }
        .v2-live-toggle {
          display: flex; justify-content: space-between; align-items: center;
          padding: var(--v2-space-md); border: 1px solid var(--v2-border);
          border-radius: var(--v2-radius-sm); margin-top: var(--v2-space-xs);
        }
        .v2-live-toggle--disabled {
          opacity: 0.5; cursor: not-allowed;
        }
        .v2-live-toggle-label {
          font-family: var(--v2-font-data); font-size: 11px;
          font-weight: 600; text-transform: uppercase; letter-spacing: 1px;
          color: var(--v2-text-secondary);
        }
        .v2-live-toggle-value {
          font-family: var(--v2-font-data); font-size: 12px;
          font-weight: 700; letter-spacing: 1px;
          color: var(--v2-text-muted);
        }
        .v2-live-toggle--on { color: var(--v2-accent-green); }
      `}</style>
    </div>
  );
}

function LimitRow({ label, value, grad }) {
  return (
    <div className="v2-limit-row">
      <span className="v2-limit-label">{label}</span>
      <div className="v2-limit-values">
        <span className="v2-limit-value">{value}</span>
        {grad != null && grad !== value && (
          <span className="v2-limit-grad">(grad: {grad})</span>
        )}
      </div>
    </div>
  );
}

function ConfigRow({ label, value, highlight }) {
  return (
    <div className="v2-config-row">
      <span className="v2-config-label">{label}</span>
      <span className={`v2-config-value ${highlight ? 'highlight' : ''}`}>{value}</span>
    </div>
  );
}

const CORR_SYMBOLS = ['BTC', 'ETH', 'SOL'];

function CorrelationMatrix({ correlations }) {
  function getCorr(a, b) {
    if (a === b) return 1.0;
    const key1 = `${a}_${b}`;
    const key2 = `${b}_${a}`;
    return correlations[key1] ?? correlations[key2] ?? null;
  }

  function corrColor(val) {
    if (val === null) return 'var(--v2-text-muted)';
    if (val >= 0.9) return 'var(--v2-accent-red)';
    if (val >= 0.8) return 'var(--v2-accent-amber)';
    return 'var(--v2-accent-green)';
  }

  function corrBg(val) {
    if (val === null) return 'transparent';
    if (val >= 0.9) return 'rgba(239,83,80,0.08)';
    if (val >= 0.8) return 'rgba(255,167,38,0.06)';
    return 'transparent';
  }

  const computedAt = correlations.computed_at
    ? new Date(correlations.computed_at).toLocaleDateString()
    : 'defaults';

  return (
    <div className="v2-corr">
      <div className="v2-corr-grid">
        {/* Header row: corner + column headers */}
        <div className="v2-corr-cell v2-corr-corner" />
        {CORR_SYMBOLS.map(s => (
          <div key={s} className="v2-corr-cell v2-corr-header">{s}</div>
        ))}
        {/* Data rows: row header + values */}
        {CORR_SYMBOLS.map(row => {
          const cells = [
            <div key={`${row}-label`} className="v2-corr-cell v2-corr-header">{row}</div>
          ];
          for (const col of CORR_SYMBOLS) {
            const val = getCorr(row, col);
            const isDiag = row === col;
            cells.push(
              <div
                key={`${row}-${col}`}
                className={`v2-corr-cell v2-corr-val ${isDiag ? 'v2-corr-diag' : ''}`}
                style={{
                  color: isDiag ? 'var(--v2-text-muted)' : corrColor(val),
                  background: isDiag ? 'transparent' : corrBg(val),
                }}
              >
                {val !== null ? val.toFixed(2) : '--'}
              </div>
            );
          }
          return cells;
        })}
      </div>
      <div className="v2-corr-meta">
        Updated: {computedAt}
        <span className="v2-corr-legend">
          <span style={{ color: 'var(--v2-accent-green)' }}>&lt;0.8</span>
          <span style={{ color: 'var(--v2-accent-amber)' }}>0.8-0.9</span>
          <span style={{ color: 'var(--v2-accent-red)' }}>&gt;0.9</span>
        </span>
      </div>
      <style>{`
        .v2-corr { display: flex; flex-direction: column; gap: var(--v2-space-sm); }
        .v2-corr-grid {
          display: grid; grid-template-columns: 50px repeat(3, 1fr);
          gap: 2px;
        }
        .v2-corr-cell {
          padding: var(--v2-space-sm);
          font-family: var(--v2-font-data); font-size: 12px;
          font-variant-numeric: tabular-nums; text-align: center;
          border-radius: var(--v2-radius-sm);
        }
        .v2-corr-header {
          font-weight: 600; font-size: 10px; text-transform: uppercase;
          letter-spacing: 1px; color: var(--v2-text-muted);
        }
        .v2-corr-val { font-weight: 500; }
        .v2-corr-diag { opacity: 0.3; }
        .v2-corr-meta {
          font-family: var(--v2-font-data); font-size: 9px;
          color: var(--v2-text-muted); display: flex;
          justify-content: space-between; align-items: center;
        }
        .v2-corr-legend { display: flex; gap: var(--v2-space-sm); font-weight: 500; }
      `}</style>
    </div>
  );
}
