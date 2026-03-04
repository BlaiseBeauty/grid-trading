import { useEffect, useMemo, useState } from 'react';
import { useDataStore } from '../stores/data';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import {
  GlowCard, StatusPulse, SignalBadge, ProgressRing,
} from '../components/ui';
import Modal from '../components/Modal';
import CalibrationChart from '../components/CalibrationChart';

const AGENT_COLORS = {
  trend: 'cyan', momentum: 'green', volatility: 'amber', volume: 'cyan',
  pattern: 'magenta', orderflow: 'green', macro: 'amber', sentiment: 'magenta',
  strategySynthesizer: 'cyan', riskManager: 'red', positionReviewer: 'amber',
  regimeClassifier: 'green', performanceAnalyst: 'magenta', patternDiscovery: 'magenta',
};

export default function Agents() {
  const { fetchAgents, agents, decisions, regime, rejected, triggerCycle, triggerAnalysis } = useDataStore();
  const [selectedDecision, setSelectedDecision] = useState(null);
  const [decisionDetail, setDecisionDetail] = useState(null);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [analysisRunning, setAnalysisRunning] = useState(false);

  useEffect(() => { fetchAgents(); }, []);

  // Derive per-agent stats from decisions
  const agentStats = useMemo(() => {
    const stats = {};
    for (const d of decisions) {
      const name = d.agent_name;
      if (!stats[name]) {
        stats[name] = {
          lastDecision: d,
          signalCount: 0,
          lastDirection: null,
          totalCost: 0,
          durationMs: d.duration_ms || 0,
          hasError: !!d.error,
        };
        // Extract last signal direction from most recent decision
        const sigs = d.output_json?.signals || [];
        if (sigs.length > 0) {
          stats[name].signalCount = sigs.length;
          stats[name].lastDirection = sigs[0].direction;
        }
        stats[name].totalCost = parseFloat(d.cost_usd || 0);
      }
    }
    return stats;
  }, [decisions]);

  async function handleCycle() {
    setCycleRunning(true);
    try { await triggerCycle(); } catch {}
    setTimeout(() => { fetchAgents(); setCycleRunning(false); }, 2000);
  }

  async function handleAnalysis() {
    setAnalysisRunning(true);
    try { await triggerAnalysis(); } catch {}
    setTimeout(() => { fetchAgents(); setAnalysisRunning(false); }, 2000);
  }

  return (
    <div className="v2-agents">
      {/* Header */}
      <div className="v2-header v2-animate-in">
        <h1 className="v2-title">AGENTS</h1>
        <div className="v2-header-actions">
          <button className="v2-btn" onClick={handleAnalysis} disabled={analysisRunning}>
            {analysisRunning ? <><StatusPulse status="active" size={5} /> Running</> : 'Run Analysis'}
          </button>
          <button className="v2-btn v2-btn--primary" onClick={handleCycle} disabled={cycleRunning}>
            {cycleRunning ? <><StatusPulse status="active" size={5} /> Cycle Running</> : 'Run Cycle'}
          </button>
        </div>
      </div>

      {/* Agent Grid by Layer */}
      {agents && Object.entries(agents).map(([layer, list], li) => (
        <div key={layer} className={`v2-layer v2-animate-in v2-stagger-${Math.min(li + 1, 4)}`}>
          <div className="v2-layer-title">{layer} Layer</div>
          <div className="v2-agent-grid">
            {list.map((a, i) => {
              const stats = agentStats[a.name] || {};
              const color = AGENT_COLORS[a.name] || 'cyan';
              const isActive = stats.lastDecision && (Date.now() - new Date(stats.lastDecision.created_at).getTime()) < 300_000;
              return (
                <GlowCard
                  key={i}
                  className={`v2-agent-card v2-animate-in v2-stagger-${Math.min(i + 1, 8)}`}
                  glowColor={color}
                  onClick={() => {
                    if (stats.lastDecision) {
                      setSelectedDecision(stats.lastDecision);
                      api(`/agents/decisions/${stats.lastDecision.id}`)
                        .then(setDecisionDetail)
                        .catch(() => setDecisionDetail(stats.lastDecision));
                    }
                  }}
                >
                  <div className="v2-ac-top">
                    <span className={`v2-ac-name v2-ac-name--${color}`}>{a.name}</span>
                    <StatusPulse
                      status={stats.hasError ? 'error' : isActive ? 'active' : 'idle'}
                      size={6}
                    />
                  </div>
                  <div className="v2-ac-desc">{a.description}</div>
                  <div className="v2-ac-stats">
                    {stats.lastDirection && (
                      <SignalBadge direction={stats.lastDirection} size="sm" />
                    )}
                    <span className="v2-ac-stat" title="Signals from last cycle">
                      {stats.signalCount || 0} sig
                    </span>
                    {stats.durationMs > 0 && (
                      <span className="v2-ac-stat" title="Response time">
                        {stats.durationMs < 1000
                          ? `${stats.durationMs}ms`
                          : `${(stats.durationMs / 1000).toFixed(1)}s`}
                      </span>
                    )}
                    {stats.totalCost > 0 && (
                      <span className="v2-ac-cost" title="Last cycle cost">
                        ${stats.totalCost.toFixed(3)}
                      </span>
                    )}
                    <span className={`v2-ac-model ${a.model === 'opus' ? 'v2-ac-model--opus' : ''}`}>
                      {a.model}
                    </span>
                  </div>
                </GlowCard>
              );
            })}
          </div>
        </div>
      ))}

      {/* Decision History */}
      <GlowCard className="v2-animate-in v2-stagger-5">
        <div className="v2-section-title">Decision History <span className="v2-count">{decisions.length}</span></div>
        <div className="v2-dt-wrap">
          <div className="v2-dt-header">
            <span className="v2-dt-col v2-dt-agent">Agent</span>
            <span className="v2-dt-col v2-dt-cycle">Cycle</span>
            <span className="v2-dt-col v2-dt-model">Model</span>
            <span className="v2-dt-col v2-dt-tokens">Tokens</span>
            <span className="v2-dt-col v2-dt-cost">Cost</span>
            <span className="v2-dt-col v2-dt-dur">Duration</span>
            <span className="v2-dt-col v2-dt-status">Status</span>
          </div>
          {decisions.map((d, i) => (
            <div key={i} className="v2-dt-row" onClick={async () => {
              setSelectedDecision(d);
              try { setDecisionDetail(await api(`/agents/decisions/${d.id}`)); }
              catch { setDecisionDetail(d); }
            }}>
              <span className="v2-dt-col v2-dt-agent v2-agent-name-tag">{d.agent_name}</span>
              <span className="v2-dt-col v2-dt-cycle v2-mono">{d.cycle_number}</span>
              <span className="v2-dt-col v2-dt-model v2-mono">{d.model_used?.replace('claude-', '').replace('-4-6', '')}</span>
              <span className="v2-dt-col v2-dt-tokens v2-mono">{((d.input_tokens || 0) + (d.output_tokens || 0)).toLocaleString()}</span>
              <span className="v2-dt-col v2-dt-cost v2-mono v2-cost-val">${parseFloat(d.cost_usd || 0).toFixed(4)}</span>
              <span className="v2-dt-col v2-dt-dur v2-mono">{d.duration_ms ? `${(d.duration_ms / 1000).toFixed(1)}s` : '\u2014'}</span>
              <span className="v2-dt-col v2-dt-status">
                <StatusPulse status={d.error ? 'error' : 'active'} size={6} label={d.error ? 'Error' : 'OK'} />
              </span>
            </div>
          ))}
        </div>
      </GlowCard>

      {/* Regime + Rejected */}
      <div className="v2-two-col">
        <GlowCard className="v2-animate-in v2-stagger-6">
          <div className="v2-section-title">Market Regime</div>
          {regime.length === 0 ? (
            <div className="v2-empty">No regime classifications yet</div>
          ) : regime.map((r, i) => {
            const color = r.regime?.includes('up') ? 'var(--v2-accent-green)'
              : r.regime?.includes('down') ? 'var(--v2-accent-red)' : 'var(--v2-accent-amber)';
            return (
              <div key={i} className="v2-regime-row">
                <span className="v2-regime-asset">{r.asset_class}</span>
                <span className="v2-regime-badge" style={{ color, borderColor: color }}>{r.regime}</span>
                {r.sub_regime && <span className="v2-regime-sub">{r.sub_regime}</span>}
                <ProgressRing value={r.confidence || 0} size={32} strokeWidth={2.5} color={color} />
              </div>
            );
          })}
        </GlowCard>

        <GlowCard className="v2-animate-in v2-stagger-7">
          <div className="v2-section-title">Rejected Opportunities <span className="v2-count">{rejected.length}</span></div>
          {rejected.length === 0 ? (
            <div className="v2-empty">No rejected opportunities</div>
          ) : rejected.slice(0, 10).map((r, i) => (
            <div key={i} className="v2-rejected-row">
              <span className="v2-rejected-sym">{r.symbol}</span>
              <SignalBadge direction={r.direction === 'long' ? 'long' : r.direction === 'short' ? 'short' : 'neutral'} />
              <span className="v2-rejected-reason">{r.rejection_reason}</span>
              <span className="v2-rejected-time">{timeAgo(r.created_at)}</span>
            </div>
          ))}
        </GlowCard>
      </div>

      {/* Confidence Calibration */}
      <GlowCard className="v2-animate-in v2-stagger-8" glowColor="cyan">
        <CalibrationChart />
      </GlowCard>

      {/* Decision Detail Modal */}
      <Modal
        open={!!selectedDecision}
        onClose={() => { setSelectedDecision(null); setDecisionDetail(null); }}
        title={`${selectedDecision?.agent_name || ''} \u2014 Cycle ${selectedDecision?.cycle_number || ''}`}
      >
        {decisionDetail && (
          <div className="v2-dd">
            <div className="v2-dd-meta">
              <DDRow label="Model" value={decisionDetail.model_used} />
              <DDRow label="Input Tokens" value={(decisionDetail.input_tokens || 0).toLocaleString()} />
              <DDRow label="Output Tokens" value={(decisionDetail.output_tokens || 0).toLocaleString()} />
              <DDRow label="Cost" value={`$${parseFloat(decisionDetail.cost_usd || 0).toFixed(4)}`} color="var(--v2-accent-magenta)" />
              <DDRow label="Duration" value={decisionDetail.duration_ms ? `${decisionDetail.duration_ms}ms` : '\u2014'} />
              <DDRow label="Time" value={decisionDetail.created_at ? new Date(decisionDetail.created_at).toLocaleString() : '\u2014'} />
            </div>
            {decisionDetail.error && (
              <div className="v2-dd-section">
                <div className="v2-dd-stitle">Error</div>
                <pre className="v2-dd-pre v2-dd-error">{decisionDetail.error}</pre>
              </div>
            )}
            {decisionDetail.output_json && (
              <div className="v2-dd-section">
                <div className="v2-dd-stitle">Output</div>
                {decisionDetail.output_json.signals?.length > 0 && (
                  <div style={{ marginBottom: 'var(--v2-space-sm)' }}>
                    <div className="v2-dd-sub">Signals ({decisionDetail.output_json.signals.length})</div>
                    {decisionDetail.output_json.signals.map((s, i) => (
                      <div key={i} className="v2-dd-sig-row">
                        <span className="v2-dd-sig-type">{s.signal_type}</span>
                        <SignalBadge direction={s.direction} />
                        <span className="v2-mono">{s.strength}</span>
                        <span className="v2-dd-sig-sym">{s.symbol}</span>
                      </div>
                    ))}
                  </div>
                )}
                {decisionDetail.output_json.proposals?.length > 0 && (
                  <div style={{ marginBottom: 'var(--v2-space-sm)' }}>
                    <div className="v2-dd-sub">Proposals ({decisionDetail.output_json.proposals.length})</div>
                    {decisionDetail.output_json.proposals.map((p, i) => (
                      <div key={i} className="v2-dd-sig-row">
                        <span className="v2-dd-sig-sym">{p.symbol}</span>
                        <SignalBadge direction={p.direction} />
                        <span className="v2-mono">{p.confidence}%</span>
                      </div>
                    ))}
                  </div>
                )}
                {decisionDetail.output_json.summary && (
                  <p className="v2-dd-summary">{decisionDetail.output_json.summary}</p>
                )}
                <details className="v2-dd-raw">
                  <summary className="v2-dd-raw-toggle">Raw JSON</summary>
                  <pre className="v2-dd-pre">{JSON.stringify(decisionDetail.output_json, null, 2)}</pre>
                </details>
              </div>
            )}
          </div>
        )}
      </Modal>

      <style>{`
        .v2-agents { display: flex; flex-direction: column; gap: var(--v2-space-sm); }
        .v2-header { display: flex; justify-content: space-between; align-items: center; padding: var(--v2-space-xs) 0; }
        .v2-title { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 16px; letter-spacing: 6px; color: var(--v2-text-primary); }
        .v2-header-actions { display: flex; gap: var(--v2-space-sm); align-items: center; }
        .v2-btn { padding: 6px 14px; border: 1px solid var(--v2-border-hover); border-radius: var(--v2-radius-sm); font-family: var(--v2-font-data); font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; color: var(--v2-text-secondary); background: transparent; cursor: pointer; transition: all var(--v2-duration-fast) var(--v2-ease-out); display: flex; align-items: center; gap: var(--v2-space-xs); }
        .v2-btn:hover { border-color: var(--v2-accent-cyan); color: var(--v2-accent-cyan); }
        .v2-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .v2-btn--primary { background: var(--v2-accent-cyan); color: var(--v2-bg-primary); border-color: var(--v2-accent-cyan); font-weight: 600; }
        .v2-btn--primary:hover { opacity: 0.85; }

        .v2-layer-title { font-family: var(--v2-font-data); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; color: var(--v2-text-muted); margin-bottom: var(--v2-space-sm); }
        .v2-agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--v2-space-sm); }
        .v2-agent-card { cursor: pointer; }
        .v2-ac-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--v2-space-xs); }
        .v2-ac-name { font-family: var(--v2-font-data); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
        .v2-ac-name--cyan { color: var(--v2-accent-cyan); }
        .v2-ac-name--green { color: var(--v2-accent-green); }
        .v2-ac-name--amber { color: var(--v2-accent-amber); }
        .v2-ac-name--magenta { color: var(--v2-accent-magenta); }
        .v2-ac-name--red { color: var(--v2-accent-red); }
        .v2-ac-desc { font-family: var(--v2-font-body); font-size: 11px; color: var(--v2-text-muted); margin-bottom: var(--v2-space-sm); }
        .v2-ac-stats { display: flex; align-items: center; gap: var(--v2-space-sm); flex-wrap: wrap; }
        .v2-ac-stat { font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-text-muted); }
        .v2-ac-cost { font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-accent-magenta); }
        .v2-ac-model { font-family: var(--v2-font-data); font-size: 9px; font-weight: 500; padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,0.04); color: var(--v2-text-muted); border: 1px solid var(--v2-border); margin-left: auto; }
        .v2-ac-model--opus { color: var(--v2-accent-magenta); border-color: rgba(224,64,251,0.3); background: rgba(224,64,251,0.05); }

        .v2-section-title { font-family: var(--v2-font-data); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; color: var(--v2-text-muted); margin-bottom: var(--v2-space-md); }
        .v2-count { color: var(--v2-accent-cyan); margin-left: var(--v2-space-xs); }
        .v2-dt-wrap { overflow-x: auto; }
        .v2-dt-header, .v2-dt-row { display: grid; grid-template-columns: 140px 55px 80px 80px 70px 70px 80px; gap: var(--v2-space-sm); align-items: center; padding: var(--v2-space-sm) 0; }
        .v2-dt-header { font-family: var(--v2-font-data); font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--v2-text-muted); border-bottom: 1px solid var(--v2-border); }
        .v2-dt-row { font-size: 12px; border-bottom: 1px solid var(--v2-border); cursor: pointer; transition: background var(--v2-duration-fast); }
        .v2-dt-row:hover { background: rgba(0,229,255,0.03); }
        .v2-agent-name-tag { font-family: var(--v2-font-data); font-weight: 500; font-size: 11px; color: var(--v2-accent-magenta); text-transform: uppercase; }
        .v2-mono { font-family: var(--v2-font-data); font-variant-numeric: tabular-nums; }
        .v2-cost-val { color: var(--v2-accent-magenta); }

        .v2-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--v2-space-sm); }
        .v2-empty { color: var(--v2-text-muted); font-family: var(--v2-font-body); font-size: 13px; padding: var(--v2-space-xl) 0; text-align: center; }
        .v2-regime-row { display: flex; align-items: center; gap: var(--v2-space-md); padding: var(--v2-space-sm) 0; border-bottom: 1px solid var(--v2-border); }
        .v2-regime-asset { font-family: var(--v2-font-data); font-weight: 500; font-size: 12px; color: var(--v2-text-secondary); min-width: 50px; text-transform: uppercase; }
        .v2-regime-badge { font-family: var(--v2-font-data); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; padding: 3px 10px; border-radius: var(--v2-radius-full); border: 1px solid; }
        .v2-regime-sub { font-family: var(--v2-font-body); font-size: 11px; color: var(--v2-text-muted); flex: 1; }
        .v2-rejected-row { display: flex; align-items: center; gap: var(--v2-space-sm); padding: var(--v2-space-xs) 0; font-size: 12px; border-bottom: 1px solid var(--v2-border); }
        .v2-rejected-sym { font-family: var(--v2-font-data); font-weight: 500; font-size: 11px; min-width: 80px; color: var(--v2-text-primary); }
        .v2-rejected-reason { color: var(--v2-text-secondary); flex: 1; font-size: 11px; }
        .v2-rejected-time { color: var(--v2-text-muted); font-size: 10px; }

        .v2-dd { display: flex; flex-direction: column; gap: var(--v2-space-lg); }
        .v2-dd-meta { display: flex; flex-direction: column; gap: 2px; }
        .v2-dd-row { display: flex; justify-content: space-between; padding: 4px 0; }
        .v2-dd-label { font-size: 12px; color: var(--v2-text-secondary); }
        .v2-dd-value { font-family: var(--v2-font-data); font-size: 12px; color: var(--v2-text-primary); font-variant-numeric: tabular-nums; }
        .v2-dd-section { border-top: 1px solid var(--v2-border); padding-top: var(--v2-space-md); }
        .v2-dd-stitle { font-family: var(--v2-font-data); font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--v2-text-muted); margin-bottom: var(--v2-space-sm); }
        .v2-dd-sub { font-family: var(--v2-font-data); font-size: 10px; font-weight: 500; color: var(--v2-accent-cyan); margin-bottom: var(--v2-space-xs); }
        .v2-dd-sig-row { display: flex; align-items: center; gap: var(--v2-space-sm); padding: 3px 0; font-size: 12px; }
        .v2-dd-sig-type { color: var(--v2-text-secondary); flex: 1; }
        .v2-dd-sig-sym { font-family: var(--v2-font-data); font-weight: 500; font-size: 11px; min-width: 70px; color: var(--v2-text-primary); }
        .v2-dd-summary { font-size: 12px; color: var(--v2-text-secondary); line-height: 1.6; margin: 0; }
        .v2-dd-raw { margin-top: var(--v2-space-sm); }
        .v2-dd-raw-toggle { font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-text-muted); cursor: pointer; }
        .v2-dd-raw-toggle:hover { color: var(--v2-accent-cyan); }
        .v2-dd-pre { font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-text-secondary); background: var(--v2-bg-primary); border: 1px solid var(--v2-border); border-radius: var(--v2-radius-sm); padding: var(--v2-space-md); margin-top: var(--v2-space-xs); overflow-x: auto; max-height: 300px; white-space: pre-wrap; }
        .v2-dd-error { color: var(--v2-accent-red); }

        @media (max-width: 768px) {
          .v2-agent-grid { grid-template-columns: 1fr; }
          .v2-two-col { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}

function DDRow({ label, value, color }) {
  return (
    <div className="v2-dd-row">
      <span className="v2-dd-label">{label}</span>
      <span className="v2-dd-value" style={color ? { color } : undefined}>{value}</span>
    </div>
  );
}
