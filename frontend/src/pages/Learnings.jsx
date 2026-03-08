import { useEffect, useState, useCallback, useRef } from 'react';
import { GlowCard, StatusPulse } from '../components/ui';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';

// ════════════════════════════════════════════════════════════════
// LEARNINGS — Knowledge Intelligence Page
// ════════════════════════════════════════════════════════════════

const TABS = ['PIPELINE', 'CONFLICTS', 'AUDIT'];
const STAGES = ['candidate', 'provisional', 'active', 'decaying'];
const STAGE_COLORS = {
  candidate: 'var(--v2-accent-amber)',
  provisional: 'var(--v2-accent-cyan)',
  active: 'var(--v2-accent-magenta)',
  decaying: 'var(--v2-accent-red)',
};
const EVENT_COLORS = {
  referenced: 'var(--v2-text-muted)',
  cited: 'var(--v2-accent-magenta)',
  trade_won: 'var(--v2-accent-green)',
  trade_lost: 'var(--v2-accent-red)',
};
const RESOLVE_OPTIONS = [
  { key: 'kept_a', label: 'KEEP A' },
  { key: 'kept_b', label: 'KEEP B' },
  { key: 'regime_dependent', label: 'REGIME DEPENDENT' },
  { key: 'merged', label: 'MERGE \u2014 LEAVE BOTH ACTIVE' },
];

export default function Learnings() {
  const [stats, setStats] = useState(null);
  const [learnings, setLearnings] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [tab, setTab] = useState('PIPELINE');
  const [selectedId, setSelectedId] = useState(null);
  const [influence, setInfluence] = useState(null);
  const [loadingInfluence, setLoadingInfluence] = useState(false);
  const [fadingConflicts, setFadingConflicts] = useState(new Set());
  const intervalRef = useRef(null);

  const fetchAll = useCallback(async () => {
    try {
      const [s, l, c] = await Promise.all([
        api('/learnings/stats'),
        api('/learnings'),
        api('/learnings/conflicts'),
      ]);
      setStats(s);
      setLearnings(l);
      setConflicts(c);
    } catch (err) {
      console.error('[Learnings] fetch failed:', err.message);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    intervalRef.current = setInterval(fetchAll, 60_000);
    return () => clearInterval(intervalRef.current);
  }, [fetchAll]);

  // Fetch influence detail when a learning is selected in audit tab
  useEffect(() => {
    if (selectedId == null) { setInfluence(null); return; }
    let cancelled = false;
    setLoadingInfluence(true);
    api(`/learnings/${selectedId}/influence`).then(data => {
      if (!cancelled) { setInfluence(data); setLoadingInfluence(false); }
    }).catch(() => { if (!cancelled) setLoadingInfluence(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  async function handleInvalidate(id) {
    try {
      await api(`/learnings/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ stage: 'invalidated', invalidation_reason: 'operator' }),
      });
      fetchAll();
    } catch (err) {
      console.error('[Learnings] invalidate failed:', err.message);
    }
  }

  async function handleResolve(conflictId, resolution) {
    try {
      setFadingConflicts(prev => new Set(prev).add(conflictId));
      await api(`/learnings/conflicts/${conflictId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolution }),
      });
      setTimeout(() => {
        setConflicts(prev => prev.filter(c => c.id !== conflictId));
        setFadingConflicts(prev => { const n = new Set(prev); n.delete(conflictId); return n; });
        fetchAll();
      }, 400);
    } catch (err) {
      console.error('[Learnings] resolve failed:', err.message);
      setFadingConflicts(prev => { const n = new Set(prev); n.delete(conflictId); return n; });
    }
  }

  const byStage = (stage) => learnings.filter(l => l.stage === stage);

  // ── Helpers ──
  function winRate(l) {
    if (!l.influenced_trades || l.influenced_trades === 0) return null;
    return Math.round((l.influenced_wins / l.influenced_trades) * 1000) / 10;
  }
  function confPct(l) {
    if (l.decayed_confidence == null) return null;
    return Math.round(l.decayed_confidence * 100);
  }
  function isHighPerf(l) {
    return l.stage === 'active' && l.decayed_confidence > 0.7 && winRate(l) > 60;
  }

  function stageProgress(l) {
    const wr = winRate(l);
    switch (l.stage) {
      case 'candidate': {
        const trades = l.influenced_trades || 0;
        const pct = Math.min(trades / 5, 1) * 100;
        return { label: `${trades}/5 trades`, pct, sublabel: wr != null ? `${wr}% WR (need >55%)` : 'Need >55% win rate' };
      }
      case 'provisional': {
        const rb = l.regime_breakdown || {};
        const regimes = Object.keys(rb).length;
        const pct = Math.min(regimes / 2, 1) * 100;
        return { label: `${regimes}/2 regimes`, pct, sublabel: regimes < 2 ? 'Need 2 distinct regimes' : 'Ready for active' };
      }
      case 'active': {
        const conf = confPct(l);
        return { label: conf != null ? `${conf}% confidence` : '\u2014', pct: conf || 0, sublabel: 'Decaying over time' };
      }
      case 'decaying': {
        return { label: wr != null ? `${wr}% WR` : '\u2014', pct: wr != null ? Math.max(0, wr) : 0, sublabel: 'vs 55% threshold' };
      }
      default: return { label: '\u2014', pct: 0, sublabel: '' };
    }
  }

  // ════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════

  return (
    <div className="ln-page">
      {/* ── Page Title ── */}
      <div className="ln-header v2-animate-in">
        <h1 className="ln-title">LEARNINGS</h1>
        <span className="ln-subtitle">Knowledge Intelligence</span>
      </div>

      {/* ── KPI Strip ── */}
      <div className="ln-kpi-strip">
        <KpiTile label="TOTAL LEARNINGS" value={stats?.total} stagger={1} />
        <KpiTile label="ACTIVE" value={stats?.by_stage?.active} color="var(--v2-accent-magenta)" stagger={2} />
        <KpiTile label="PROVISIONAL" value={stats?.by_stage?.provisional} color="var(--v2-accent-amber)" stagger={3} />
        <KpiTile label="CANDIDATES" value={stats?.by_stage?.candidate} color="var(--v2-text-muted)" stagger={4} />
        <KpiTile
          label="KNOWLEDGE WIN RATE"
          value={stats?.knowledge_win_rate != null ? `${stats.knowledge_win_rate}%` : '\u2014'}
          color={
            stats?.knowledge_win_rate == null ? 'var(--v2-text-muted)'
            : stats.knowledge_win_rate > 55 ? 'var(--v2-accent-green)'
            : stats.knowledge_win_rate >= 40 ? 'var(--v2-accent-amber)'
            : 'var(--v2-accent-red)'
          }
          stagger={5}
        />
        <KpiTile label="AVG CONFIDENCE" value={stats?.avg_decayed_confidence != null ? `${Math.round(stats.avg_decayed_confidence * 100)}%` : '\u2014'} color="var(--v2-accent-cyan)" stagger={6} />
        <KpiTile
          label="CONFLICTS"
          value={stats?.conflicts_unresolved ?? 0}
          color={stats?.conflicts_unresolved > 0 ? 'var(--v2-accent-red)' : 'var(--v2-text-muted)'}
          pulse={stats?.conflicts_unresolved > 0}
          stagger={7}
        />
      </div>

      {/* ── Tab Nav ── */}
      <div className="ln-tabs v2-animate-in v2-stagger-8">
        {TABS.map(t => (
          <button key={t} className={`ln-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {/* ── Tab Content ── */}
      {tab === 'PIPELINE' && <PipelineView learnings={learnings} byStage={byStage} onInvalidate={handleInvalidate} winRate={winRate} confPct={confPct} isHighPerf={isHighPerf} stageProgress={stageProgress} />}
      {tab === 'CONFLICTS' && <ConflictsView conflicts={conflicts} fading={fadingConflicts} onResolve={handleResolve} />}
      {tab === 'AUDIT' && <AuditView learnings={learnings} selectedId={selectedId} setSelectedId={setSelectedId} influence={influence} loading={loadingInfluence} winRate={winRate} confPct={confPct} />}

      <style>{STYLES}</style>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// KPI TILE
// ════════════════════════════════════════════════════════════════

function KpiTile({ label, value, color, pulse, stagger }) {
  return (
    <GlowCard className={`ln-kpi v2-animate-in v2-stagger-${stagger}`} glowColor="magenta">
      <div className="ln-kpi-label">{label}</div>
      <div className="ln-kpi-value" style={{ color: color || 'var(--v2-text-primary)' }}>
        {pulse && <span className="ln-pulse-dot" />}
        {value ?? '\u2014'}
      </div>
    </GlowCard>
  );
}

// ════════════════════════════════════════════════════════════════
// TAB 1: PIPELINE (Kanban)
// ════════════════════════════════════════════════════════════════

function PipelineView({ learnings, byStage, onInvalidate, winRate, confPct, isHighPerf, stageProgress }) {
  return (
    <div className="ln-pipeline v2-animate-in">
      {STAGES.map(stage => {
        const items = byStage(stage);
        return (
          <div className="ln-column" key={stage}>
            <div className="ln-column-header">
              <span className="ln-column-title">{stage.toUpperCase()}</span>
              <span className="ln-column-count" style={{ background: `${STAGE_COLORS[stage]}22`, color: STAGE_COLORS[stage], borderColor: `${STAGE_COLORS[stage]}44` }}>{items.length}</span>
            </div>
            <div className="ln-column-cards">
              {items.map(l => (
                <LearningCard key={l.id} learning={l} onInvalidate={onInvalidate} winRate={winRate} confPct={confPct} isHighPerf={isHighPerf} stageProgress={stageProgress} />
              ))}
              {items.length === 0 && <div className="ln-empty-col">No learnings</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LearningCard({ learning: l, onInvalidate, winRate, confPct, isHighPerf, stageProgress }) {
  const wr = winRate(l);
  const conf = confPct(l);
  const hp = isHighPerf(l);
  const prog = stageProgress(l);
  const hasConflict = (l.unresolved_conflicts || 0) > 0;

  return (
    <div className={`ln-card ${hp ? 'ln-card--glow' : ''}`}>
      {hasConflict && <span className="ln-card-conflict-icon" title="Unresolved conflict">\u26a0</span>}
      <div className="ln-card-badges">
        {l.learning_type && <span className="ln-badge ln-badge--type">{l.learning_type.toUpperCase()}</span>}
        {l.scope_level && <span className="ln-badge ln-badge--scope">{l.scope_level.toUpperCase()}</span>}
      </div>
      <p className="ln-card-insight">{l.insight_text}</p>
      <div className="ln-card-divider" />
      <div className="ln-card-stats">
        <div className="ln-stat">
          <span className="ln-stat-label">CONFIDENCE</span>
          <span className="ln-stat-value">{conf != null ? `${conf}%` : '\u2014'}</span>
        </div>
        <div className="ln-stat">
          <span className="ln-stat-label">TRADES</span>
          <span className="ln-stat-value">{l.influenced_trades || 0}</span>
        </div>
        <div className="ln-stat">
          <span className="ln-stat-label">WIN RATE</span>
          <span className="ln-stat-value" style={{ color: wr != null ? (wr > 55 ? 'var(--v2-accent-green)' : wr >= 45 ? 'var(--v2-accent-amber)' : 'var(--v2-accent-red)') : 'var(--v2-text-muted)' }}>
            {wr != null ? `${wr}%` : '\u2014'}
          </span>
        </div>
      </div>
      <div className="ln-progress">
        <div className="ln-progress-bar">
          <div className="ln-progress-fill" style={{ width: `${Math.min(prog.pct, 100)}%`, background: STAGE_COLORS[l.stage] }} />
        </div>
        <span className="ln-progress-label">{prog.label}</span>
      </div>
      {prog.sublabel && <div className="ln-progress-sublabel">{prog.sublabel}</div>}
      <div className="ln-card-footer">
        <span className="ln-card-time">{timeAgo(l.created_at)}</span>
        <button className="ln-btn-invalidate" onClick={() => onInvalidate(l.id)}>INVALIDATE</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// TAB 2: CONFLICTS
// ════════════════════════════════════════════════════════════════

function ConflictsView({ conflicts, fading, onResolve }) {
  if (conflicts.length === 0) {
    return (
      <div className="ln-empty-state v2-animate-in">
        <span className="ln-empty-check">\u2713</span>
        <p>No conflicts detected \u2014 knowledge base is consistent</p>
      </div>
    );
  }

  return (
    <div className="ln-conflicts v2-animate-in">
      {conflicts.map(c => (
        <div key={c.id} className={`ln-conflict-card ${fading.has(c.id) ? 'ln-fade-out' : ''}`}>
          <div className="ln-conflict-header">
            <span className="ln-conflict-type">\u26a1 {(c.conflict_type || 'DIRECTIONAL').toUpperCase()} CONFLICT</span>
            <span className="ln-conflict-time">{timeAgo(c.detected_at)}</span>
          </div>
          <div className="ln-conflict-sides">
            <ConflictSide label="LEARNING A" text={c.learning_a_text} conf={c.learning_a_confidence} type={c.learning_a_type} />
            <ConflictSide label="LEARNING B" text={c.learning_b_text} conf={c.learning_b_confidence} type={c.learning_b_type} />
          </div>
          <div className="ln-conflict-actions">
            <span className="ln-resolve-label">RESOLVE:</span>
            {RESOLVE_OPTIONS.map(opt => (
              <button key={opt.key} className={`ln-resolve-btn ${opt.key === 'merged' ? 'ln-resolve-btn--wide' : ''}`} onClick={() => onResolve(c.id, opt.key)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ConflictSide({ label, text, conf, type }) {
  const confPct = conf != null ? `${Math.round(conf * 100)}%` : '\u2014';
  return (
    <div className="ln-conflict-side">
      <div className="ln-conflict-side-label">{label}</div>
      {type && <span className="ln-badge ln-badge--type" style={{ marginBottom: 6 }}>{type.toUpperCase()}</span>}
      <p className="ln-conflict-side-text">{text?.slice(0, 120)}{text?.length > 120 ? '\u2026' : ''}</p>
      <div className="ln-conflict-side-stat">
        <span className="ln-stat-label">CONF</span>
        <span className="ln-stat-value">{confPct}</span>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// TAB 3: AUDIT
// ════════════════════════════════════════════════════════════════

function AuditView({ learnings, selectedId, setSelectedId, influence, loading, winRate, confPct }) {
  return (
    <div className="ln-audit v2-animate-in">
      {/* Left: learning list */}
      <div className="ln-audit-list">
        {learnings.map(l => {
          const wr = winRate(l);
          return (
            <div key={l.id} className={`ln-audit-row ${selectedId === l.id ? 'active' : ''}`} onClick={() => setSelectedId(l.id)}>
              <span className="ln-badge ln-badge--type ln-badge--sm">{(l.learning_type || '?').toUpperCase()}</span>
              <span className="ln-audit-text">{l.insight_text?.slice(0, 60)}{l.insight_text?.length > 60 ? '\u2026' : ''}</span>
              <span className="ln-audit-wr num">{wr != null ? `${wr}%` : '\u2014'}</span>
              <span className="ln-audit-refs num">{l.times_referenced || 0}x</span>
            </div>
          );
        })}
        {learnings.length === 0 && <div className="ln-empty-col">No learnings</div>}
      </div>

      {/* Right: detail panel */}
      <div className="ln-audit-detail">
        {selectedId == null && (
          <div className="ln-audit-placeholder">Select a learning to view its influence timeline</div>
        )}
        {selectedId != null && loading && (
          <div className="ln-audit-placeholder">Loading...</div>
        )}
        {selectedId != null && !loading && influence && (
          <AuditDetail influence={influence} winRate={winRate} confPct={confPct} />
        )}
      </div>
    </div>
  );
}

function AuditDetail({ influence, winRate, confPct }) {
  const l = influence.learning;
  const wr = winRate(l);
  const conf = confPct(l);
  const rb = influence.regime_breakdown || {};
  const regimes = Object.entries(rb);

  return (
    <div className="ln-detail v2-slide-in">
      {/* Header */}
      <div className="ln-detail-header">
        <div className="ln-detail-badges">
          {l.learning_type && <span className="ln-badge ln-badge--type">{l.learning_type.toUpperCase()}</span>}
          {l.scope_level && <span className="ln-badge ln-badge--scope">{l.scope_level.toUpperCase()}</span>}
          <span className="ln-badge" style={{ color: STAGE_COLORS[l.stage], borderColor: STAGE_COLORS[l.stage] }}>{(l.stage || '?').toUpperCase()}</span>
        </div>
        <p className="ln-detail-insight">{l.insight_text}</p>
        <div className="ln-card-stats" style={{ marginTop: 12 }}>
          <div className="ln-stat"><span className="ln-stat-label">CONFIDENCE</span><span className="ln-stat-value">{conf != null ? `${conf}%` : '\u2014'}</span></div>
          <div className="ln-stat"><span className="ln-stat-label">TRADES</span><span className="ln-stat-value">{l.influenced_trades || 0}</span></div>
          <div className="ln-stat"><span className="ln-stat-label">WIN RATE</span><span className="ln-stat-value" style={{ color: wr != null && wr > 55 ? 'var(--v2-accent-green)' : wr != null && wr >= 45 ? 'var(--v2-accent-amber)' : wr != null ? 'var(--v2-accent-red)' : undefined }}>{wr != null ? `${wr}%` : '\u2014'}</span></div>
          <div className="ln-stat"><span className="ln-stat-label">REFERENCED</span><span className="ln-stat-value">{l.times_referenced || 0}x</span></div>
          <div className="ln-stat"><span className="ln-stat-label">CREATED</span><span className="ln-stat-value">{timeAgo(l.created_at)}</span></div>
        </div>
      </div>

      {/* Regime Breakdown */}
      {regimes.length > 0 && (
        <div className="ln-detail-section">
          <div className="ln-section-title">REGIME BREAKDOWN</div>
          {regimes.map(([regime, data]) => {
            const trades = data.trades || 0;
            const wins = data.wins || 0;
            const rwr = trades > 0 ? Math.round((wins / trades) * 100) : 0;
            const maxTrades = Math.max(...regimes.map(([, d]) => d.trades || 0), 1);
            const barPct = (trades / maxTrades) * 100;
            return (
              <div className="ln-regime-row" key={regime}>
                <span className="ln-regime-label">{regime.toUpperCase()}</span>
                <div className="ln-regime-bar-track">
                  <div className="ln-regime-bar-fill" style={{ width: `${barPct}%`, background: rwr > 55 ? 'var(--v2-accent-green)' : rwr >= 45 ? 'var(--v2-accent-amber)' : 'var(--v2-accent-red)' }} />
                </div>
                <span className="ln-regime-stat num">{trades} trade{trades !== 1 ? 's' : ''}</span>
                <span className="ln-regime-wr num" style={{ color: rwr > 55 ? 'var(--v2-accent-green)' : rwr >= 45 ? 'var(--v2-accent-amber)' : 'var(--v2-accent-red)' }}>{rwr}% WR</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Confidence Decay */}
      <div className="ln-detail-section">
        <div className="ln-section-title">CONFIDENCE DECAY</div>
        <ConfidenceDecayBar original={l.confidence} decayed={l.decayed_confidence} />
      </div>

      {/* Influence Timeline */}
      <div className="ln-detail-section">
        <div className="ln-section-title">INFLUENCE TIMELINE</div>
        <div className="ln-timeline">
          {(influence.events || []).map((ev, i) => (
            <div className="ln-timeline-row" key={i}>
              <span className="ln-event-badge" style={{ color: EVENT_COLORS[ev.event_type] || 'var(--v2-text-muted)', borderColor: EVENT_COLORS[ev.event_type] || 'var(--v2-border)' }}>
                {ev.event_type?.toUpperCase().replace('_', ' ')}
              </span>
              <span className="ln-event-cycle num">C{ev.cycle_number}</span>
              {ev.regime && <span className="ln-event-regime">{ev.regime}</span>}
              {ev.trade_id && <span className="ln-event-trade num">T#{ev.trade_id}</span>}
              <span className="ln-event-time">{timeAgo(ev.created_at)}</span>
            </div>
          ))}
          {(!influence.events || influence.events.length === 0) && (
            <div className="ln-empty-col">No influence events recorded</div>
          )}
        </div>
      </div>

      {/* Conflicts for this learning */}
      {influence.conflicts?.length > 0 && (
        <div className="ln-detail-section">
          <div className="ln-section-title">CONFLICTS ({influence.conflicts.length})</div>
          {influence.conflicts.map(c => (
            <div className="ln-detail-conflict" key={c.id}>
              <span className="ln-event-badge" style={{ color: 'var(--v2-accent-amber)', borderColor: 'var(--v2-accent-amber)' }}>
                {(c.conflict_type || 'DIRECTIONAL').toUpperCase()}
              </span>
              <span className="ln-detail-conflict-text">
                vs #{c.learning_a_id === l.id ? c.learning_b_id : c.learning_a_id}: {(c.learning_a_id === l.id ? c.learning_b_text : c.learning_a_text)?.slice(0, 60)}{'\u2026'}
              </span>
              {c.resolved_at && <span className="ln-badge" style={{ color: 'var(--v2-accent-green)', borderColor: 'var(--v2-accent-green)' }}>RESOLVED</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Confidence Decay Bar ──
function ConfidenceDecayBar({ original, decayed }) {
  const CONF_MAP = { high: 0.85, med: 0.6, medium: 0.6, low: 0.3 };
  const origVal = typeof original === 'string' ? (CONF_MAP[original] || 0.5) : (original || 0.5);
  const decayedVal = decayed != null ? decayed : origVal;
  const origPct = Math.round(origVal * 100);
  const decPct = Math.round(decayedVal * 100);

  return (
    <div className="ln-decay">
      <div className="ln-decay-labels">
        <span className="ln-decay-label">Original: <span className="num">{origPct}%</span></span>
        <span className="ln-decay-label">Current: <span className="num" style={{ color: 'var(--v2-accent-magenta)' }}>{decPct}%</span></span>
      </div>
      <div className="ln-decay-track">
        <div className="ln-decay-original" style={{ width: `${origPct}%` }} />
        <div className="ln-decay-current" style={{ width: `${decPct}%` }} />
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════════
// STYLES
// ════════════════════════════════════════════════════════════════

const STYLES = `
  .ln-page {
    display: flex;
    flex-direction: column;
    gap: var(--v2-space-lg);
  }

  /* ── Header ── */
  .ln-header {
    display: flex;
    align-items: baseline;
    gap: var(--v2-space-md);
  }
  .ln-title {
    font-family: 'Syne', sans-serif;
    font-weight: 800;
    font-size: 20px;
    letter-spacing: 6px;
    color: var(--v2-accent-magenta);
    margin: 0;
  }
  .ln-subtitle {
    font-family: 'Instrument Sans', sans-serif;
    font-weight: 500;
    font-size: 12px;
    color: var(--v2-text-muted);
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  /* ── KPI Strip ── */
  .ln-kpi-strip {
    display: flex;
    gap: var(--v2-space-sm);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .ln-kpi-strip::-webkit-scrollbar { display: none; }
  .ln-kpi {
    min-width: 120px;
    flex: 1;
  }
  .ln-kpi-label {
    font-family: 'Instrument Sans', sans-serif;
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--v2-text-muted);
    margin-bottom: var(--v2-space-xs);
  }
  .ln-kpi-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 20px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ln-pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v2-accent-red);
    animation: ln-pulse 1.5s ease-in-out infinite;
  }
  @keyframes ln-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(1.6); }
  }

  /* ── Tabs ── */
  .ln-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--v2-border);
  }
  .ln-tab {
    font-family: 'Instrument Sans', sans-serif;
    font-weight: 600;
    font-size: 12px;
    letter-spacing: 1.5px;
    color: var(--v2-text-muted);
    padding: var(--v2-space-md) var(--v2-space-xl);
    border-bottom: 2px solid transparent;
    transition: all var(--v2-duration-fast) var(--v2-ease-out);
    cursor: pointer;
    background: none;
    border-top: none;
    border-left: none;
    border-right: none;
  }
  .ln-tab:hover { color: var(--v2-text-secondary); }
  .ln-tab.active {
    color: var(--v2-accent-magenta);
    border-bottom-color: var(--v2-accent-magenta);
  }

  /* ── Pipeline (Kanban) ── */
  .ln-pipeline {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--v2-space-sm);
    min-height: 400px;
  }
  .ln-column {
    display: flex;
    flex-direction: column;
    gap: var(--v2-space-sm);
  }
  .ln-column-header {
    display: flex;
    align-items: center;
    gap: var(--v2-space-sm);
    padding: var(--v2-space-sm) 0;
  }
  .ln-column-title {
    font-family: 'Instrument Sans', sans-serif;
    font-weight: 600;
    font-size: 11px;
    letter-spacing: 1.5px;
    color: var(--v2-text-secondary);
  }
  .ln-column-count {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 10px;
    border: 1px solid;
    font-variant-numeric: tabular-nums;
  }
  .ln-column-cards {
    display: flex;
    flex-direction: column;
    gap: var(--v2-space-sm);
    flex: 1;
  }
  .ln-empty-col {
    font-family: 'Outfit', sans-serif;
    font-size: 12px;
    color: var(--v2-text-muted);
    text-align: center;
    padding: var(--v2-space-xl);
  }

  /* ── Learning Card ── */
  .ln-card {
    position: relative;
    background: var(--v2-bg-card);
    border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius-md);
    padding: var(--v2-space-md);
    transition: border-color var(--v2-duration-fast) var(--v2-ease-out), box-shadow var(--v2-duration-fast);
  }
  .ln-card:hover {
    border-color: var(--v2-border-hover);
  }
  .ln-card--glow {
    border-color: rgba(179,157,219,0.4);
    box-shadow: 0 0 0 1px rgba(179,157,219,0.4), 0 0 12px rgba(179,157,219,0.15);
  }
  .ln-card-conflict-icon {
    position: absolute;
    top: 8px;
    right: 8px;
    font-size: 14px;
    color: var(--v2-accent-amber);
  }
  .ln-card-badges {
    display: flex;
    gap: 4px;
    margin-bottom: var(--v2-space-sm);
    flex-wrap: wrap;
  }
  .ln-badge {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: var(--v2-radius-sm);
    border: 1px solid var(--v2-border);
    color: var(--v2-text-secondary);
    white-space: nowrap;
  }
  .ln-badge--type {
    color: var(--v2-accent-magenta);
    border-color: rgba(179,157,219,0.3);
    background: rgba(179,157,219,0.08);
  }
  .ln-badge--scope {
    color: var(--v2-accent-cyan);
    border-color: rgba(79,195,247,0.3);
    background: rgba(79,195,247,0.08);
  }
  .ln-badge--sm {
    font-size: 7px;
    padding: 1px 4px;
  }
  .ln-card-insight {
    font-family: 'Outfit', sans-serif;
    font-size: 13px;
    font-weight: 400;
    color: var(--v2-text-primary);
    line-height: 1.5;
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ln-card-divider {
    border-top: 1px dashed var(--v2-border);
    margin: var(--v2-space-sm) 0;
  }
  .ln-card-stats {
    display: flex;
    gap: var(--v2-space-md);
  }
  .ln-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ln-stat-label {
    font-family: 'Instrument Sans', sans-serif;
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--v2-text-muted);
  }
  .ln-stat-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    font-weight: 500;
    color: var(--v2-text-primary);
    font-variant-numeric: tabular-nums;
  }

  /* ── Progress Bar ── */
  .ln-progress {
    display: flex;
    align-items: center;
    gap: var(--v2-space-sm);
    margin-top: var(--v2-space-sm);
  }
  .ln-progress-bar {
    flex: 1;
    height: 4px;
    background: rgba(255,255,255,0.06);
    border-radius: var(--v2-radius-sm);
    overflow: hidden;
  }
  .ln-progress-fill {
    height: 100%;
    border-radius: var(--v2-radius-sm);
    transition: width 0.5s var(--v2-ease-out);
  }
  .ln-progress-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--v2-text-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .ln-progress-sublabel {
    font-family: 'Outfit', sans-serif;
    font-size: 10px;
    color: var(--v2-text-muted);
    margin-top: 2px;
  }

  /* ── Card Footer ── */
  .ln-card-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: var(--v2-space-sm);
  }
  .ln-card-time {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--v2-text-muted);
  }
  .ln-btn-invalidate {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.5px;
    color: var(--v2-accent-red);
    background: rgba(239,83,80,0.08);
    border: 1px solid rgba(239,83,80,0.2);
    border-radius: var(--v2-radius-sm);
    padding: 3px 8px;
    cursor: pointer;
    transition: all var(--v2-duration-fast);
  }
  .ln-btn-invalidate:hover {
    background: rgba(239,83,80,0.15);
    border-color: rgba(239,83,80,0.4);
  }

  /* ── Conflicts View ── */
  .ln-conflicts {
    display: flex;
    flex-direction: column;
    gap: var(--v2-space-md);
  }
  .ln-conflict-card {
    background: var(--v2-bg-card);
    border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius-md);
    padding: var(--v2-space-lg);
    transition: opacity 0.4s, transform 0.4s;
  }
  .ln-fade-out {
    opacity: 0;
    transform: translateY(-8px);
    pointer-events: none;
  }
  .ln-conflict-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--v2-space-md);
  }
  .ln-conflict-type {
    font-family: 'Instrument Sans', sans-serif;
    font-weight: 600;
    font-size: 12px;
    letter-spacing: 1px;
    color: var(--v2-accent-amber);
  }
  .ln-conflict-time {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--v2-text-muted);
  }
  .ln-conflict-sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--v2-space-md);
    margin-bottom: var(--v2-space-lg);
  }
  .ln-conflict-side {
    background: var(--v2-bg-secondary);
    border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius-sm);
    padding: var(--v2-space-md);
  }
  .ln-conflict-side-label {
    font-family: 'Instrument Sans', sans-serif;
    font-weight: 600;
    font-size: 10px;
    letter-spacing: 1px;
    color: var(--v2-text-muted);
    margin-bottom: var(--v2-space-sm);
  }
  .ln-conflict-side-text {
    font-family: 'Outfit', sans-serif;
    font-size: 13px;
    color: var(--v2-text-primary);
    line-height: 1.5;
    margin: 0 0 var(--v2-space-sm);
  }
  .ln-conflict-side-stat {
    display: flex;
    gap: var(--v2-space-sm);
    align-items: baseline;
  }
  .ln-conflict-actions {
    display: flex;
    align-items: center;
    gap: var(--v2-space-sm);
    flex-wrap: wrap;
  }
  .ln-resolve-label {
    font-family: 'Instrument Sans', sans-serif;
    font-weight: 600;
    font-size: 10px;
    letter-spacing: 1px;
    color: var(--v2-text-muted);
    margin-right: var(--v2-space-xs);
  }
  .ln-resolve-btn {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.5px;
    color: var(--v2-text-secondary);
    background: var(--v2-bg-elevated);
    border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius-sm);
    padding: 5px 10px;
    cursor: pointer;
    transition: all var(--v2-duration-fast);
  }
  .ln-resolve-btn:hover {
    color: var(--v2-accent-magenta);
    border-color: rgba(179,157,219,0.4);
    background: rgba(179,157,219,0.08);
  }
  .ln-resolve-btn--wide {
    flex-basis: 100%;
    text-align: center;
    margin-top: 2px;
  }

  /* ── Empty State ── */
  .ln-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--v2-space-3xl);
    gap: var(--v2-space-md);
  }
  .ln-empty-check {
    font-size: 32px;
    color: var(--v2-accent-green);
  }
  .ln-empty-state p {
    font-family: 'Outfit', sans-serif;
    font-size: 14px;
    color: var(--v2-text-secondary);
    margin: 0;
  }

  /* ── Audit View ── */
  .ln-audit {
    display: grid;
    grid-template-columns: 30% 70%;
    gap: 0;
    min-height: 500px;
    background: var(--v2-bg-card);
    border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius-md);
    overflow: hidden;
  }
  .ln-audit-list {
    border-right: 1px solid var(--v2-border);
    overflow-y: auto;
    max-height: 700px;
  }
  .ln-audit-row {
    display: flex;
    align-items: center;
    gap: var(--v2-space-sm);
    padding: var(--v2-space-sm) var(--v2-space-md);
    border-bottom: 1px solid var(--v2-border);
    cursor: pointer;
    transition: background var(--v2-duration-fast);
    border-left: 2px solid transparent;
  }
  .ln-audit-row:hover {
    background: var(--v2-bg-hover);
  }
  .ln-audit-row.active {
    border-left-color: var(--v2-accent-magenta);
    background: var(--v2-bg-elevated);
  }
  .ln-audit-text {
    font-family: 'Outfit', sans-serif;
    font-size: 12px;
    color: var(--v2-text-primary);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ln-audit-wr, .ln-audit-refs {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--v2-text-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .ln-audit-detail {
    overflow-y: auto;
    max-height: 700px;
  }
  .ln-audit-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    font-family: 'Outfit', sans-serif;
    font-size: 13px;
    color: var(--v2-text-muted);
  }

  /* ── Detail Panel ── */
  .ln-detail {
    padding: var(--v2-space-lg);
    display: flex;
    flex-direction: column;
    gap: var(--v2-space-lg);
  }
  .ln-detail-header {
    padding-bottom: var(--v2-space-md);
    border-bottom: 1px solid var(--v2-border);
  }
  .ln-detail-badges {
    display: flex;
    gap: 4px;
    margin-bottom: var(--v2-space-sm);
    flex-wrap: wrap;
  }
  .ln-detail-insight {
    font-family: 'Outfit', sans-serif;
    font-size: 14px;
    font-weight: 400;
    color: var(--v2-text-primary);
    line-height: 1.6;
    margin: 0;
  }
  .ln-detail-section {
    display: flex;
    flex-direction: column;
    gap: var(--v2-space-sm);
  }
  .ln-section-title {
    font-family: 'Instrument Sans', sans-serif;
    font-weight: 600;
    font-size: 10px;
    letter-spacing: 1.5px;
    color: var(--v2-text-muted);
    text-transform: uppercase;
    padding-bottom: var(--v2-space-xs);
    border-bottom: 1px solid var(--v2-border);
  }

  /* ── Regime Bars ── */
  .ln-regime-row {
    display: flex;
    align-items: center;
    gap: var(--v2-space-sm);
  }
  .ln-regime-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 1px;
    color: var(--v2-text-secondary);
    min-width: 90px;
  }
  .ln-regime-bar-track {
    flex: 1;
    height: 6px;
    background: rgba(255,255,255,0.06);
    border-radius: var(--v2-radius-sm);
    overflow: hidden;
  }
  .ln-regime-bar-fill {
    height: 100%;
    border-radius: var(--v2-radius-sm);
    transition: width 0.5s var(--v2-ease-out);
  }
  .ln-regime-stat {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--v2-text-secondary);
    min-width: 60px;
    text-align: right;
  }
  .ln-regime-wr {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    font-weight: 500;
    min-width: 50px;
    text-align: right;
  }

  /* ── Decay Bar ── */
  .ln-decay {
    display: flex;
    flex-direction: column;
    gap: var(--v2-space-xs);
  }
  .ln-decay-labels {
    display: flex;
    justify-content: space-between;
  }
  .ln-decay-label {
    font-family: 'Outfit', sans-serif;
    font-size: 11px;
    color: var(--v2-text-muted);
  }
  .ln-decay-track {
    position: relative;
    height: 8px;
    background: rgba(255,255,255,0.04);
    border-radius: 4px;
    overflow: hidden;
  }
  .ln-decay-original {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    background: rgba(179,157,219,0.15);
    border-radius: 4px;
  }
  .ln-decay-current {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    background: var(--v2-accent-magenta);
    border-radius: 4px;
    transition: width 0.5s var(--v2-ease-out);
  }

  /* ── Timeline ── */
  .ln-timeline {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ln-timeline-row {
    display: flex;
    align-items: center;
    gap: var(--v2-space-sm);
    padding: var(--v2-space-xs) 0;
  }
  .ln-event-badge {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 0.5px;
    padding: 2px 6px;
    border: 1px solid;
    border-radius: var(--v2-radius-sm);
    white-space: nowrap;
  }
  .ln-event-cycle {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--v2-text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .ln-event-regime {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    color: var(--v2-text-muted);
    letter-spacing: 0.5px;
  }
  .ln-event-trade {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--v2-accent-cyan);
  }
  .ln-event-time {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    color: var(--v2-text-muted);
    margin-left: auto;
  }

  /* ── Detail Conflicts ── */
  .ln-detail-conflict {
    display: flex;
    align-items: center;
    gap: var(--v2-space-sm);
    padding: var(--v2-space-xs) 0;
  }
  .ln-detail-conflict-text {
    font-family: 'Outfit', sans-serif;
    font-size: 11px;
    color: var(--v2-text-secondary);
    flex: 1;
  }

  /* ── Responsive ── */
  @media (max-width: 1200px) {
    .ln-pipeline { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 768px) {
    .ln-pipeline { grid-template-columns: 1fr; }
    .ln-audit { grid-template-columns: 1fr; }
    .ln-audit-list { max-height: 300px; border-right: none; border-bottom: 1px solid var(--v2-border); }
    .ln-conflict-sides { grid-template-columns: 1fr; }
    .ln-kpi-strip { flex-wrap: nowrap; }
    .ln-kpi { min-width: 100px; }
  }

  /* ── Number utility ── */
  .num {
    font-family: 'IBM Plex Mono', monospace;
    font-variant-numeric: tabular-nums;
  }
`;
