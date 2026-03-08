import { useCycleStore } from '../stores/cycle';

const LAYER_LABELS = {
  knowledge: 'KNOWLEDGE',
  review: 'REVIEW',
  strategy: 'STRATEGY',
  analysis: 'ANALYSIS',
};

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatCost(usd) {
  if (usd == null || usd === 0) return '--';
  return `$${Number(usd).toFixed(2)}`;
}

function formatDuration(ms) {
  if (ms == null) return '--';
  return `${(ms / 1000).toFixed(1)}s`;
}

function timeAgoShort(ts) {
  if (!ts) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const STATUS_ICON = { pending: '\u25CB', running: '\u25CF', done: '\u2713', error: '\u2715' };

export default function CycleControl() {
  const phase = useCycleStore(s => s.phase);
  const panelMode = useCycleStore(s => s.panelMode);
  const cycleNumber = useCycleStore(s => s.cycleNumber);
  const agents = useCycleStore(s => s.agents);
  const elapsed = useCycleStore(s => s.elapsed);
  const totalCost = useCycleStore(s => s.totalCost);
  const totalSignals = useCycleStore(s => s.totalSignals);
  const errorMessage = useCycleStore(s => s.errorMessage);
  const lastCycleNumber = useCycleStore(s => s.lastCycleNumber);
  const lastCycleTime = useCycleStore(s => s.lastCycleTime);
  const cycleResult = useCycleStore(s => s.cycleResult);

  const requestCycle = useCycleStore(s => s.requestCycle);
  const cancelConfirm = useCycleStore(s => s.cancelConfirm);
  const confirmCycle = useCycleStore(s => s.confirmCycle);
  const dismissError = useCycleStore(s => s.dismissError);
  const dismissSuccess = useCycleStore(s => s.dismissSuccess);
  const togglePanel = useCycleStore(s => s.togglePanel);
  const expand = useCycleStore(s => s.expand);
  const getProgress = useCycleStore(s => s.getProgress);

  const progress = (phase === 'running' || phase === 'success') ? getProgress() : 0;

  // Group agents by layer
  const layerGroups = {};
  for (const agent of agents) {
    if (!layerGroups[agent.layer]) layerGroups[agent.layer] = [];
    layerGroups[agent.layer].push(agent);
  }

  const layerOrder = ['knowledge', 'review', 'strategy', 'analysis'];
  const doneCount = agents.filter(a => a.status === 'done' || a.status === 'error').length;

  // --- IDLE PILL ---
  if (phase === 'idle') {
    return (
      <div className="cc-root">
        <div className="cc-pill cc-pill--idle" onClick={requestCycle}>
          <span className="cc-pill-dot cc-dot--idle" />
          <span className="cc-pill-text">
            {lastCycleNumber ? `CYCLE #${lastCycleNumber}` : 'NO CYCLES'}
            {lastCycleTime && <span className="cc-pill-ago"> {timeAgoShort(lastCycleTime)}</span>}
          </span>
          <button className="cc-run-btn" onClick={(e) => { e.stopPropagation(); requestCycle(); }}>
            RUN CYCLE
          </button>
        </div>
        <Style />
      </div>
    );
  }

  // --- CONFIRMING ---
  if (phase === 'confirming') {
    return (
      <div className="cc-root">
        <div className="cc-panel cc-panel--confirm">
          <div className="cc-confirm-text">Run full agent cycle (~14 min)?</div>
          <div className="cc-confirm-actions">
            <button className="cc-btn cc-btn--primary" onClick={confirmCycle}>CONFIRM</button>
            <button className="cc-btn cc-btn--ghost" onClick={cancelConfirm}>CANCEL</button>
          </div>
        </div>
        <Style />
      </div>
    );
  }

  // --- STARTING ---
  if (phase === 'starting') {
    return (
      <div className="cc-root">
        <div className="cc-pill cc-pill--starting">
          <span className="cc-pill-dot cc-dot--starting" />
          <span className="cc-pill-text">STARTING...</span>
        </div>
        <Style />
      </div>
    );
  }

  // --- ERROR ---
  if (phase === 'error') {
    return (
      <div className="cc-root">
        <div className="cc-panel cc-panel--error">
          <div className="cc-error-header">
            <span className="cc-error-icon">{STATUS_ICON.error}</span>
            <span className="cc-error-title">CYCLE ERROR</span>
          </div>
          <div className="cc-error-msg">{errorMessage}</div>
          <button className="cc-btn cc-btn--ghost" onClick={dismissError}>DISMISS</button>
        </div>
        <Style />
      </div>
    );
  }

  // --- SUCCESS ---
  if (phase === 'success') {
    return (
      <div className="cc-root">
        <div className="cc-panel cc-panel--success">
          <div className="cc-success-header">
            <span className="cc-success-icon">{STATUS_ICON.done}</span>
            <span className="cc-success-title">CYCLE #{cycleNumber} COMPLETE</span>
          </div>
          <div className="cc-success-stats">
            <div className="cc-stat">
              <span className="cc-stat-label">Duration</span>
              <span className="cc-stat-value">{formatElapsed(elapsed)}</span>
            </div>
            <div className="cc-stat">
              <span className="cc-stat-label">Cost</span>
              <span className="cc-stat-value">{formatCost(totalCost)}</span>
            </div>
            <div className="cc-stat">
              <span className="cc-stat-label">Signals</span>
              <span className="cc-stat-value">{totalSignals}</span>
            </div>
            {cycleResult?.strategy && (
              <div className="cc-stat">
                <span className="cc-stat-label">Trades</span>
                <span className="cc-stat-value">{cycleResult.strategy.trades || 0}</span>
              </div>
            )}
          </div>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={dismissSuccess}>DISMISS</button>
        </div>
        <Style />
      </div>
    );
  }

  // --- RUNNING ---
  if (phase === 'running' && panelMode === 'collapsed') {
    return (
      <div className="cc-root">
        <div className="cc-pill cc-pill--running" onClick={expand}>
          <span className="cc-pill-dot cc-dot--running" />
          <span className="cc-pill-text">
            RUNNING #{cycleNumber} {formatElapsed(elapsed)} {doneCount}/{agents.length}
          </span>
          <span className="cc-pill-expand" onClick={(e) => { e.stopPropagation(); expand(); }}>&#9650;</span>
        </div>
        <Style />
      </div>
    );
  }

  // --- RUNNING EXPANDED ---
  return (
    <div className="cc-root">
      <div className="cc-panel cc-panel--running">
        {/* Header */}
        <div className="cc-header">
          <span className="cc-header-title">CYCLE #{cycleNumber}</span>
          <span className="cc-header-elapsed">{formatElapsed(elapsed)}</span>
          <span className="cc-header-cost">{formatCost(totalCost)}</span>
        </div>

        <div className="cc-divider" />

        {/* Agent rows grouped by layer */}
        <div className="cc-agents-scroll">
          {layerOrder.map(layer => {
            const group = layerGroups[layer];
            if (!group || group.length === 0) return null;
            const layerDone = group.filter(a => a.status === 'done' || a.status === 'error').length;
            return (
              <div key={layer} className="cc-layer">
                <div className="cc-layer-header">
                  <span className="cc-layer-name">{LAYER_LABELS[layer]}</span>
                  <span className="cc-layer-count">{layerDone}/{group.length}</span>
                </div>
                {group.map(agent => (
                  <div
                    key={agent.name}
                    className={`cc-agent-row cc-agent--${agent.status}`}
                  >
                    <span className={`cc-agent-icon cc-icon--${agent.status}`}>
                      {STATUS_ICON[agent.status]}
                    </span>
                    <span className="cc-agent-name">{agent.name}</span>
                    <span className="cc-agent-duration">{formatDuration(agent.duration_ms)}</span>
                    <span className="cc-agent-cost">{formatCost(agent.cost_usd)}</span>
                    <span className="cc-agent-signals">
                      {agent.signals_count != null ? agent.signals_count : '--'}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {/* Progress bar + collapse */}
        <div className="cc-footer">
          <div className="cc-progress-track">
            <div className="cc-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="cc-progress-pct">{progress}%</span>
          <button className="cc-collapse-btn" onClick={togglePanel}>&#9660;</button>
        </div>
      </div>
      <Style />
    </div>
  );
}

function Style() {
  return (
    <style>{`
      .cc-root {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 9999;
        font-family: var(--v2-font-data, 'JetBrains Mono', monospace);
      }

      /* ── Pills ── */
      .cc-pill {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        border-radius: 20px;
        background: var(--v2-glass-bg, rgba(10,10,18,0.9));
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid var(--v2-border, rgba(255,255,255,0.06));
        cursor: pointer;
        transition: all 0.2s ease;
        user-select: none;
      }
      .cc-pill:hover {
        border-color: var(--v2-border-hover, rgba(255,255,255,0.12));
      }
      .cc-pill-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .cc-dot--idle {
        background: var(--v2-text-muted, #555);
      }
      .cc-dot--starting {
        background: var(--v2-accent-amber, #ffa726);
        animation: cc-pulse 1.5s ease-in-out infinite;
      }
      .cc-dot--running {
        background: var(--v2-accent-cyan, #4fc3f7);
        animation: cc-pulse 1.5s ease-in-out infinite;
      }
      .cc-pill-text {
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.5px;
        color: var(--v2-text-secondary, #aaa);
        text-transform: uppercase;
        white-space: nowrap;
      }
      .cc-pill-ago {
        color: var(--v2-text-muted, #666);
        font-size: 10px;
      }
      .cc-pill-expand {
        font-size: 10px;
        color: var(--v2-text-muted, #666);
        cursor: pointer;
        padding: 2px;
      }
      .cc-pill--running {
        border-color: rgba(79, 195, 247, 0.2);
      }

      /* ── Run Button ── */
      .cc-run-btn {
        padding: 4px 12px;
        border: 1px solid var(--v2-accent-cyan, #4fc3f7);
        border-radius: 12px;
        background: var(--v2-accent-cyan, #4fc3f7);
        color: var(--v2-bg-primary, #0a0a12);
        font-family: var(--v2-font-data, monospace);
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 1px;
        cursor: pointer;
        transition: opacity 0.15s;
        white-space: nowrap;
      }
      .cc-run-btn:hover { opacity: 0.85; }

      /* ── Panels ── */
      .cc-panel {
        width: 380px;
        background: var(--v2-glass-bg, rgba(10,10,18,0.95));
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid var(--v2-border, rgba(255,255,255,0.06));
        border-radius: var(--v2-radius-md, 8px);
        padding: 16px;
        animation: cc-slide-up 0.25s ease-out;
      }
      .cc-panel--confirm {
        text-align: center;
        width: 320px;
      }
      .cc-panel--running {
        border-color: rgba(79, 195, 247, 0.15);
        box-shadow: 0 0 30px rgba(79, 195, 247, 0.05);
      }
      .cc-panel--success {
        border-color: rgba(102, 187, 106, 0.3);
        box-shadow: 0 0 30px rgba(102, 187, 106, 0.08);
      }
      .cc-panel--error {
        border-color: rgba(239, 83, 80, 0.3);
        box-shadow: 0 0 30px rgba(239, 83, 80, 0.08);
        width: 340px;
      }

      /* ── Confirm ── */
      .cc-confirm-text {
        font-size: 12px;
        color: var(--v2-text-secondary, #aaa);
        margin-bottom: 14px;
      }
      .cc-confirm-actions {
        display: flex;
        gap: 8px;
        justify-content: center;
      }

      /* ── Buttons ── */
      .cc-btn {
        padding: 6px 16px;
        border-radius: var(--v2-radius-sm, 4px);
        font-family: var(--v2-font-data, monospace);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.5px;
        cursor: pointer;
        transition: all 0.15s ease;
        text-transform: uppercase;
      }
      .cc-btn--primary {
        background: var(--v2-accent-cyan, #4fc3f7);
        color: var(--v2-bg-primary, #0a0a12);
        border: 1px solid var(--v2-accent-cyan, #4fc3f7);
      }
      .cc-btn--primary:hover { opacity: 0.85; }
      .cc-btn--ghost {
        background: transparent;
        color: var(--v2-text-muted, #666);
        border: 1px solid var(--v2-border, rgba(255,255,255,0.06));
      }
      .cc-btn--ghost:hover {
        border-color: var(--v2-border-hover, rgba(255,255,255,0.12));
        color: var(--v2-text-secondary, #aaa);
      }
      .cc-btn--sm { padding: 4px 12px; font-size: 9px; }

      /* ── Error ── */
      .cc-error-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
      }
      .cc-error-icon {
        color: var(--v2-accent-red, #ef5350);
        font-size: 14px;
      }
      .cc-error-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--v2-accent-red, #ef5350);
        letter-spacing: 1px;
      }
      .cc-error-msg {
        font-size: 11px;
        color: var(--v2-text-secondary, #aaa);
        margin-bottom: 12px;
        line-height: 1.4;
        word-break: break-word;
      }

      /* ── Success ── */
      .cc-success-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }
      .cc-success-icon {
        color: var(--v2-accent-green, #66bb6a);
        font-size: 16px;
      }
      .cc-success-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--v2-accent-green, #66bb6a);
        letter-spacing: 1px;
      }
      .cc-success-stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin-bottom: 12px;
      }
      .cc-stat {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .cc-stat-label {
        font-size: 9px;
        color: var(--v2-text-muted, #666);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .cc-stat-value {
        font-size: 14px;
        font-weight: 500;
        color: var(--v2-text-primary, #eee);
        font-variant-numeric: tabular-nums;
      }

      /* ── Running Panel ── */
      .cc-header {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .cc-header-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--v2-accent-cyan, #4fc3f7);
        letter-spacing: 1px;
        flex: 1;
      }
      .cc-header-elapsed {
        font-size: 13px;
        font-weight: 500;
        color: var(--v2-text-primary, #eee);
        font-variant-numeric: tabular-nums;
      }
      .cc-header-cost {
        font-size: 12px;
        color: var(--v2-text-secondary, #aaa);
        font-variant-numeric: tabular-nums;
      }
      .cc-divider {
        height: 1px;
        background: var(--v2-border, rgba(255,255,255,0.06));
        margin: 10px 0;
      }

      /* ── Agents List ── */
      .cc-agents-scroll {
        max-height: 400px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: var(--v2-border-hover, rgba(255,255,255,0.12)) transparent;
      }
      .cc-layer {
        margin-bottom: 8px;
      }
      .cc-layer-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 4px 0;
      }
      .cc-layer-name {
        font-size: 9px;
        font-weight: 700;
        color: var(--v2-text-muted, #666);
        letter-spacing: 1.5px;
      }
      .cc-layer-count {
        font-size: 9px;
        color: var(--v2-text-muted, #666);
        font-variant-numeric: tabular-nums;
      }

      /* ── Agent Row ── */
      .cc-agent-row {
        display: grid;
        grid-template-columns: 16px 1fr 48px 48px 28px;
        align-items: center;
        gap: 4px;
        padding: 3px 6px;
        border-radius: var(--v2-radius-sm);
        transition: background 0.15s;
      }
      .cc-agent--running {
        background: rgba(79, 195, 247, 0.06);
      }
      .cc-agent--error {
        background: rgba(239, 83, 80, 0.06);
      }
      .cc-agent-icon {
        font-size: 10px;
        text-align: center;
      }
      .cc-icon--pending { color: var(--v2-text-muted, #555); }
      .cc-icon--running { color: var(--v2-accent-cyan, #4fc3f7); animation: cc-pulse 1.5s ease-in-out infinite; }
      .cc-icon--done { color: var(--v2-accent-green, #66bb6a); }
      .cc-icon--error { color: var(--v2-accent-red, #ef5350); }

      .cc-agent-name {
        font-size: 10px;
        color: var(--v2-text-secondary, #aaa);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cc-agent--done .cc-agent-name { color: var(--v2-text-primary, #eee); }
      .cc-agent--running .cc-agent-name { color: var(--v2-accent-cyan, #4fc3f7); }

      .cc-agent-duration,
      .cc-agent-cost,
      .cc-agent-signals {
        font-size: 9px;
        color: var(--v2-text-muted, #666);
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .cc-agent--done .cc-agent-duration,
      .cc-agent--done .cc-agent-cost {
        color: var(--v2-text-secondary, #aaa);
      }
      .cc-agent--done .cc-agent-signals {
        color: var(--v2-accent-magenta, #b39ddb);
        font-weight: 600;
      }

      /* ── Footer / Progress ── */
      .cc-footer {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
      }
      .cc-progress-track {
        flex: 1;
        height: 3px;
        background: var(--v2-border, rgba(255,255,255,0.06));
        border-radius: var(--v2-radius-sm);
        overflow: hidden;
      }
      .cc-progress-fill {
        height: 100%;
        background: var(--v2-accent-cyan, #4fc3f7);
        border-radius: var(--v2-radius-sm);
        transition: width 0.5s ease-out;
        box-shadow: 0 0 6px rgba(79, 195, 247, 0.3);
      }
      .cc-progress-pct {
        font-size: 10px;
        font-weight: 500;
        color: var(--v2-text-muted, #666);
        min-width: 28px;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .cc-collapse-btn {
        background: none;
        border: 1px solid var(--v2-border, rgba(255,255,255,0.06));
        border-radius: var(--v2-radius-sm);
        color: var(--v2-text-muted, #666);
        cursor: pointer;
        font-size: 10px;
        padding: 2px 6px;
        transition: all 0.15s;
      }
      .cc-collapse-btn:hover {
        border-color: var(--v2-border-hover, rgba(255,255,255,0.12));
        color: var(--v2-text-secondary, #aaa);
      }

      /* ── Animations ── */
      @keyframes cc-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      @keyframes cc-slide-up {
        from {
          opacity: 0;
          transform: translateY(12px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      /* ── Mobile ── */
      @media (max-width: 768px) {
        .cc-root {
          bottom: 12px;
          right: 12px;
          left: 12px;
        }
        .cc-panel {
          width: auto;
        }
        .cc-panel--confirm {
          width: auto;
        }
        .cc-panel--error {
          width: auto;
        }
        .cc-success-stats {
          grid-template-columns: repeat(2, 1fr);
        }
      }
    `}</style>
  );
}
