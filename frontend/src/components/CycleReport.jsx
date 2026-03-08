import { useEffect } from 'react';
import { useCycleReportStore } from '../stores/cycleReport';
import { timeAgo } from '../lib/format';

export default function CycleReport() {
  const report = useCycleReportStore(s => s.latestReport);
  const fetchHistory = useCycleReportStore(s => s.fetchHistory);

  useEffect(() => { fetchHistory(); }, []);

  if (!report) {
    return (
      <div className="cr-panel">
        <div className="cr-title">LAST CYCLE REPORT</div>
        <div className="cr-skeleton"><div className="cr-shimmer" /></div>
        <Style />
      </div>
    );
  }

  const r = report;
  const durationSec = r.duration_ms != null ? (Number(r.duration_ms) / 1000).toFixed(1) : '—';

  return (
    <div className="cr-panel">
      <div className="cr-title">LAST CYCLE REPORT</div>

      {/* Header row */}
      <div className="cr-header">
        <span className="cr-cycle-id">CYCLE #{r.cycle_id}</span>
        <span className="cr-sep" />
        <span className="cr-regime">{r.regime.classification} <span className="cr-mono">{r.regime.confidence}%</span></span>
        <span className="cr-sep" />
        <span className="cr-mono">{durationSec}s</span>
        <span className="cr-sep" />
        <span className="cr-time">{timeAgo(r.completed_at)}</span>
      </div>

      {/* Agent signal badges */}
      <div className="cr-agents-row">
        {r.knowledge_agents.map(a => (
          <span
            key={a.name}
            className={`cr-agent-badge ${a.status === 'error' ? 'cr-badge-loss' : a.signals === 0 ? 'cr-badge-warn' : 'cr-badge-profit'}`}
          >
            {a.name} <span className="cr-badge-count">{a.signals}</span>
          </span>
        ))}
      </div>

      {/* Pipeline summary — 3 columns */}
      <div className="cr-pipeline">
        <div className="cr-pipeline-col">
          <div className="cr-pipeline-label">SYNTHESIZER</div>
          <div className="cr-pipeline-value">
            <span className="cr-mono">{r.synthesizer.proposals}</span>p
            {' + '}
            <span className="cr-mono">{r.synthesizer.standing_orders}</span>so
          </div>
        </div>
        <div className="cr-pipeline-col">
          <div className="cr-pipeline-label">RISK MANAGER</div>
          <div className="cr-pipeline-value">
            <span className="cr-mono">{r.risk_manager.approved}</span> approved
            {' / '}
            <span className="cr-mono">{r.risk_manager.rejected}</span> rejected
          </div>
        </div>
        <div className="cr-pipeline-col">
          <div className="cr-pipeline-label">POSITIONS</div>
          <div className="cr-pipeline-value">
            <span className="cr-mono">{r.position_manager.held}</span> held
            {' / '}
            <span className="cr-mono">{r.position_manager.closed}</span> closed
          </div>
        </div>
      </div>

      {/* Layer 3 */}
      <div className="cr-layer3">
        <div className="cr-layer3-item">
          <span className="cr-layer3-label">PERFORMANCE ANALYST</span>
          <span className={`cr-layer3-status ${r.performance_analyst.status === 'ok' ? 'cr-status-ok' : r.performance_analyst.status === 'error' ? 'cr-status-error' : 'cr-status-skip'}`}>
            {r.performance_analyst.status === 'ok' ? 'OK'
              : r.performance_analyst.status === 'error' ? `ERROR: ${(r.performance_analyst.error || '').slice(0, 60)}`
              : 'SKIPPED'}
          </span>
        </div>
        <div className="cr-layer3-item">
          <span className="cr-layer3-label">PATTERN DISCOVERY</span>
          <span className={`cr-layer3-status ${r.pattern_discovery.status === 'ok' ? 'cr-status-ok' : r.pattern_discovery.status === 'error' ? 'cr-status-error' : 'cr-status-skip'}`}>
            {r.pattern_discovery.status === 'ok' ? `${r.pattern_discovery.signals_found} signals`
              : r.pattern_discovery.status === 'error' ? `ERROR: ${(r.pattern_discovery.error || '').slice(0, 60)}`
              : 'SKIPPED'}
          </span>
        </div>
      </div>

      {/* Warnings */}
      {r.warnings.length > 0 && (
        <div className="cr-warnings">
          {r.warnings.map((w, i) => (
            <div key={i} className="cr-warning-line">{w}</div>
          ))}
        </div>
      )}

      <Style />
    </div>
  );
}

function Style() {
  return (
    <style>{`
      .cr-panel {
        padding: var(--v2-space-lg, 16px);
      }
      .cr-title {
        font-family: 'Instrument Sans', sans-serif;
        font-weight: 600;
        font-size: 13px;
        color: var(--v2-text-secondary, #8b8e99);
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 12px;
      }

      /* Header */
      .cr-header {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 12px;
        font-family: 'Outfit', sans-serif;
        font-size: 13px;
        color: var(--v2-text-secondary, #8b8e99);
      }
      .cr-cycle-id {
        font-family: 'IBM Plex Mono', monospace;
        font-weight: 600;
        font-size: 14px;
        color: var(--v2-text-primary, #e0e2e7);
      }
      .cr-sep {
        width: 1px;
        height: 14px;
        background: var(--v2-border, rgba(255,255,255,0.06));
      }
      .cr-regime {
        font-weight: 500;
      }
      .cr-mono {
        font-family: 'IBM Plex Mono', monospace;
        font-variant-numeric: tabular-nums;
      }
      .cr-time {
        color: var(--v2-text-muted, #5c5f6b);
        font-size: 12px;
      }

      /* Agent badges */
      .cr-agents-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 12px;
      }
      .cr-agent-badge {
        font-family: 'IBM Plex Mono', monospace;
        font-weight: 600;
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 1px;
        padding: 3px 8px;
        border-radius: var(--v2-radius-sm);
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .cr-badge-count {
        font-variant-numeric: tabular-nums;
      }
      .cr-badge-profit {
        color: var(--v2-accent-green, #66bb6a);
        background: rgba(102, 187, 106, 0.10);
      }
      .cr-badge-warn {
        color: var(--v2-accent-amber, #ffa726);
        background: rgba(255, 167, 38, 0.10);
      }
      .cr-badge-loss {
        color: var(--v2-accent-red, #ef5350);
        background: rgba(239, 83, 80, 0.10);
      }

      /* Pipeline summary */
      .cr-pipeline {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 8px;
        margin-bottom: 12px;
      }
      .cr-pipeline-col {
        padding: 8px;
        background: var(--v2-bg-card, rgba(255,255,255,0.02));
        border-radius: 6px;
        border: 1px solid var(--v2-border, rgba(255,255,255,0.06));
      }
      .cr-pipeline-label {
        font-family: 'IBM Plex Mono', monospace;
        font-weight: 600;
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--v2-text-muted, #5c5f6b);
        margin-bottom: 4px;
      }
      .cr-pipeline-value {
        font-family: 'Outfit', sans-serif;
        font-size: 13px;
        color: var(--v2-text-primary, #e0e2e7);
      }

      /* Layer 3 */
      .cr-layer3 {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 12px;
      }
      .cr-layer3-item {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 12px;
      }
      .cr-layer3-label {
        font-family: 'IBM Plex Mono', monospace;
        font-weight: 600;
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--v2-text-muted, #5c5f6b);
        min-width: 150px;
      }
      .cr-layer3-status {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
      }
      .cr-status-ok { color: var(--v2-accent-green, #66bb6a); }
      .cr-status-error { color: var(--v2-accent-red, #ef5350); }
      .cr-status-skip { color: var(--v2-text-muted, #5c5f6b); }

      /* Warnings */
      .cr-warnings {
        border-left: 2px solid var(--v2-accent-amber, #ffa726);
        padding: 8px 12px;
        margin-top: 4px;
      }
      .cr-warning-line {
        font-family: 'Outfit', sans-serif;
        font-size: 12px;
        color: var(--v2-accent-amber, #ffa726);
        line-height: 1.6;
      }

      /* Skeleton loading */
      .cr-skeleton {
        height: 120px;
        border-radius: 6px;
        overflow: hidden;
      }
      .cr-shimmer {
        width: 100%;
        height: 100%;
        background: linear-gradient(90deg, var(--v2-bg-card, rgba(34,36,43,0.85)) 25%, var(--v2-bg-hover, rgba(255,255,255,0.04)) 50%, var(--v2-bg-card, rgba(34,36,43,0.85)) 75%);
        background-size: 200% 100%;
        animation: cr-shimmer 1.5s infinite;
      }
      @keyframes cr-shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    `}</style>
  );
}
