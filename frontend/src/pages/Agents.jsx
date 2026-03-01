import { useEffect, useState } from 'react';
import { useDataStore } from '../stores/data';
import { api } from '../lib/api';
import { timeAgo, formatNum } from '../lib/format';
import Modal from '../components/Modal';

export default function Agents() {
  const { fetchAgents, agents, decisions, regime, rejected, triggerCycle, triggerAnalysis } = useDataStore();
  const [selectedDecision, setSelectedDecision] = useState(null);
  const [decisionDetail, setDecisionDetail] = useState(null);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [analysisRunning, setAnalysisRunning] = useState(false);

  useEffect(() => { fetchAgents(); }, []);

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
    <div className="agents-page">
      <div className="page-header">
        <h1 className="page-title">AGENTS</h1>
        <div className="header-actions">
          <button className="action-btn" onClick={handleAnalysis} disabled={analysisRunning}>
            {analysisRunning ? 'Running...' : 'Run Analysis'}
          </button>
          <button className="action-btn primary" onClick={handleCycle} disabled={cycleRunning}>
            {cycleRunning ? 'Cycle Running...' : 'Run Cycle'}
          </button>
        </div>
      </div>

      {/* Agent Registry */}
      {agents && (
        <div className="agent-layers">
          {Object.entries(agents).map(([layer, list]) => (
            <div key={layer} className="panel">
              <div className="panel-title">{layer} Layer</div>
              <div className="agent-grid">
                {list.map((a, i) => (
                  <div key={i} className="agent-card">
                    <div className="agent-header">
                      <span className="agent-name-tag">{a.name}</span>
                      <span className={`badge badge-${a.model === 'opus' ? 'ai' : 'neutral'}`}>
                        {a.model}
                      </span>
                    </div>
                    <div className="agent-desc">{a.description}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Decision History */}
      <div className="panel">
        <div className="panel-title">Decision History ({decisions.length})</div>
        <div className="decision-table">
          <div className="table-header">
            <span className="col-agent">Agent</span>
            <span className="col-cycle">Cycle</span>
            <span className="col-model">Model</span>
            <span className="col-tokens">Tokens</span>
            <span className="col-cost">Cost</span>
            <span className="col-time">Time</span>
            <span className="col-status">Status</span>
          </div>
          {decisions.map((d, i) => (
            <div key={i} className="table-row clickable" onClick={async () => {
              setSelectedDecision(d);
              try {
                const detail = await api(`/agents/decisions/${d.id}`);
                setDecisionDetail(detail);
              } catch { setDecisionDetail(d); }
            }}>
              <span className="col-agent agent-name-tag">{d.agent_name}</span>
              <span className="col-cycle num">{d.cycle_number}</span>
              <span className="col-model">{d.model_used?.replace('claude-', '')}</span>
              <span className="col-tokens num">{((d.input_tokens || 0) + (d.output_tokens || 0)).toLocaleString()}</span>
              <span className="col-cost num" style={{ color: 'var(--ai)' }}>${parseFloat(d.cost_usd || 0).toFixed(4)}</span>
              <span className="col-time">{timeAgo(d.created_at)}</span>
              <span className="col-status">
                {d.error
                  ? <span className="badge badge-loss">Error</span>
                  : <span className="badge badge-profit">OK</span>
                }
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Market Regime History */}
      <div className="two-col">
        <div className="panel">
          <div className="panel-title">Market Regime</div>
          {regime.length === 0 ? (
            <div className="empty-state">No regime classifications yet</div>
          ) : regime.map((r, i) => (
            <div key={i} className="regime-detail">
              <div className="regime-header-row">
                <span className="regime-asset">{r.asset_class}</span>
                <span className={`badge badge-${r.regime?.includes('up') ? 'profit' : r.regime?.includes('down') ? 'loss' : 'neutral'}`}>
                  {r.regime}
                </span>
                <span className="num" style={{ color: 'var(--t3)' }}>{r.confidence}%</span>
              </div>
              {r.sub_regime && <div className="regime-sub-detail">Sub: {r.sub_regime}</div>}
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="panel-title">Rejected Opportunities ({rejected.length})</div>
          {rejected.length === 0 ? (
            <div className="empty-state">No rejected opportunities</div>
          ) : rejected.slice(0, 10).map((r, i) => (
            <div key={i} className="rejected-row">
              <span className="rejected-symbol">{r.symbol}</span>
              <span className="rejected-dir">{r.direction}</span>
              <span className="rejected-reason">{r.rejection_reason}</span>
              <span className="rejected-time">{timeAgo(r.created_at)}</span>
            </div>
          ))}
        </div>
      </div>

      <Modal
        open={!!selectedDecision}
        onClose={() => { setSelectedDecision(null); setDecisionDetail(null); }}
        title={`${selectedDecision?.agent_name || ''} — Cycle ${selectedDecision?.cycle_number || ''}`}
      >
        {decisionDetail && (
          <div className="dd-content">
            <div className="dd-meta">
              <div className="dd-row">
                <span className="dd-label">Model</span>
                <span className="dd-value">{decisionDetail.model_used}</span>
              </div>
              <div className="dd-row">
                <span className="dd-label">Input Tokens</span>
                <span className="dd-value num">{(decisionDetail.input_tokens || 0).toLocaleString()}</span>
              </div>
              <div className="dd-row">
                <span className="dd-label">Output Tokens</span>
                <span className="dd-value num">{(decisionDetail.output_tokens || 0).toLocaleString()}</span>
              </div>
              <div className="dd-row">
                <span className="dd-label">Cost</span>
                <span className="dd-value num" style={{ color: 'var(--ai)' }}>${parseFloat(decisionDetail.cost_usd || 0).toFixed(4)}</span>
              </div>
              <div className="dd-row">
                <span className="dd-label">Duration</span>
                <span className="dd-value num">{decisionDetail.duration_ms ? `${decisionDetail.duration_ms}ms` : '—'}</span>
              </div>
              <div className="dd-row">
                <span className="dd-label">Time</span>
                <span className="dd-value">{decisionDetail.created_at ? new Date(decisionDetail.created_at).toLocaleString() : '—'}</span>
              </div>
            </div>

            {decisionDetail.error && (
              <div className="dd-section">
                <div className="dd-section-title">Error</div>
                <pre className="dd-pre dd-error">{decisionDetail.error}</pre>
              </div>
            )}

            {decisionDetail.output_json && (
              <div className="dd-section">
                <div className="dd-section-title">Output</div>
                {decisionDetail.output_json.signals?.length > 0 && (
                  <div className="dd-signals">
                    <div className="dd-subsection">Signals ({decisionDetail.output_json.signals.length})</div>
                    {decisionDetail.output_json.signals.map((s, i) => (
                      <div key={i} className="dd-signal-row">
                        <span className="signal-type">{s.signal_type}</span>
                        <span className={`badge badge-${s.direction === 'bullish' ? 'profit' : s.direction === 'bearish' ? 'loss' : 'neutral'}`}>
                          {s.direction}
                        </span>
                        <span className="num">{s.strength}</span>
                        <span className="signal-sym">{s.symbol}</span>
                      </div>
                    ))}
                  </div>
                )}
                {decisionDetail.output_json.proposals?.length > 0 && (
                  <div className="dd-signals">
                    <div className="dd-subsection">Proposals ({decisionDetail.output_json.proposals.length})</div>
                    {decisionDetail.output_json.proposals.map((p, i) => (
                      <div key={i} className="dd-signal-row">
                        <span className="signal-sym">{p.symbol}</span>
                        <span className={`badge badge-${p.direction === 'long' ? 'profit' : 'loss'}`}>{p.direction}</span>
                        <span className="num">{p.confidence}%</span>
                      </div>
                    ))}
                  </div>
                )}
                {decisionDetail.output_json.summary && (
                  <div className="dd-summary">{decisionDetail.output_json.summary}</div>
                )}
                <details className="dd-raw">
                  <summary className="dd-raw-toggle">Raw JSON</summary>
                  <pre className="dd-pre">{JSON.stringify(decisionDetail.output_json, null, 2)}</pre>
                </details>
              </div>
            )}
          </div>
        )}
      </Modal>

      <style>{`
        .agents-page { display: flex; flex-direction: column; gap: var(--space-lg); }
        .page-header { display: flex; justify-content: space-between; align-items: center; }
        .page-title {
          font-family: 'Syne', sans-serif; font-weight: 800; font-size: 18px;
          letter-spacing: 6px; color: var(--t2);
        }
        .header-actions { display: flex; gap: var(--space-sm); }
        .action-btn {
          padding: var(--space-sm) var(--space-lg);
          border: 1px solid var(--border-2); border-radius: var(--radius-sm);
          font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 0.5px; color: var(--t2);
          transition: all var(--transition-fast);
        }
        .action-btn:hover { border-color: var(--cyan); color: var(--cyan); }
        .action-btn.primary { background: var(--cyan); color: var(--void); border-color: var(--cyan); }
        .agent-layers { display: flex; flex-direction: column; gap: var(--panel-gap); }
        .agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-md); }
        .agent-card {
          background: var(--elevated); border: 1px solid var(--border-0);
          border-radius: var(--radius-sm); padding: var(--space-md);
        }
        .agent-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-xs); }
        .agent-name-tag {
          font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: 11px;
          color: var(--ai); text-transform: uppercase;
        }
        .agent-desc { color: var(--t3); font-size: 12px; }
        .decision-table { overflow-x: auto; }
        .table-header, .table-row {
          display: grid; grid-template-columns: 140px 60px 90px 80px 80px 80px 60px;
          gap: var(--space-sm); align-items: center; padding: var(--space-sm) 0;
        }
        .table-header {
          font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1px; color: var(--t4);
          border-bottom: 1px solid var(--border-1);
        }
        .table-row { font-size: 12px; border-bottom: 1px solid var(--border-0); }
        .table-row:hover { background: var(--elevated); }
        .table-row.clickable { cursor: pointer; }
        .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--panel-gap); }
        .empty-state { color: var(--t4); font-size: 13px; padding: var(--space-xl); text-align: center; }
        .regime-detail { padding: var(--space-sm) 0; border-bottom: 1px solid var(--border-0); }
        .regime-header-row { display: flex; align-items: center; gap: var(--space-sm); }
        .regime-asset {
          font-family: 'IBM Plex Mono', monospace; font-weight: 500;
          font-size: 12px; min-width: 60px;
        }
        .regime-sub-detail { font-size: 11px; color: var(--t4); margin-top: 2px; }
        .rejected-row {
          display: flex; align-items: center; gap: var(--space-sm);
          padding: var(--space-xs) 0; font-size: 12px;
        }
        .rejected-symbol {
          font-family: 'IBM Plex Mono', monospace; font-weight: 500;
          font-size: 11px; min-width: 80px;
        }
        .rejected-dir { color: var(--t3); min-width: 40px; }
        .rejected-reason { color: var(--t3); flex: 1; font-size: 11px; }
        .rejected-time { color: var(--t4); font-size: 10px; }
        .dd-content { display: flex; flex-direction: column; gap: var(--space-lg); }
        .dd-meta { display: flex; flex-direction: column; gap: 2px; }
        .dd-row { display: flex; justify-content: space-between; padding: 3px 0; }
        .dd-label { font-size: 12px; color: var(--t3); }
        .dd-value { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: var(--t1); font-variant-numeric: tabular-nums; }
        .dd-section { border-top: 1px solid var(--border-0); padding-top: var(--space-md); }
        .dd-section-title {
          font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1px; color: var(--t3);
          margin-bottom: var(--space-sm);
        }
        .dd-subsection {
          font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 500;
          color: var(--cyan); margin-bottom: var(--space-xs);
        }
        .dd-signal-row {
          display: flex; align-items: center; gap: var(--space-sm);
          padding: 3px 0; font-size: 12px;
        }
        .dd-signal-row .signal-type { color: var(--t2); flex: 1; }
        .dd-signal-row .signal-sym {
          font-family: 'IBM Plex Mono', monospace; font-weight: 500;
          font-size: 11px; min-width: 70px;
        }
        .dd-summary { font-size: 12px; color: var(--t2); line-height: 1.6; margin-top: var(--space-sm); }
        .dd-raw { margin-top: var(--space-sm); }
        .dd-raw-toggle {
          font-family: 'IBM Plex Mono', monospace; font-size: 10px;
          color: var(--t3); cursor: pointer;
        }
        .dd-raw-toggle:hover { color: var(--cyan); }
        .dd-pre {
          font-family: 'IBM Plex Mono', monospace; font-size: 10px;
          color: var(--t2); background: var(--abyss);
          border: 1px solid var(--border-0); border-radius: var(--radius-sm);
          padding: var(--space-md); margin-top: var(--space-xs);
          overflow-x: auto; max-height: 300px; white-space: pre-wrap;
        }
        .dd-error { color: var(--red); }
        .dd-signals { margin-bottom: var(--space-sm); }
      `}</style>
    </div>
  );
}
