import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';
import DetailPanel from '../../components/DetailPanel';
import { ErrorState } from '../../components/StateBlock';

export default function OracleDashboard() {
  const [theses,      setTheses]      = useState([]);
  const [oppMap,      setOppMap]      = useState(null);
  const [evidence,    setEvidence]    = useState([]);
  const [graveyard,   setGraveyard]   = useState([]);
  const [selected,    setSelected]    = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [actionError, setActionError] = useState(null);
  const [activeTab,   setActiveTab]   = useState('theses');
  const [calibration, setCalibration] = useState(null);
  const [calError,    setCalError]    = useState(null);
  const [lastCycleAt, setLastCycleAt] = useState(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Calibration is optional (the endpoint may not exist yet); its failure is shown on the
      // calibration tab instead of failing the whole page.
      const [t, o, e, g, cal] = await Promise.all([
        api('/oracle/theses'),
        api('/oracle/opportunity-map'),
        api('/oracle/evidence?limit=30'),
        api('/oracle/graveyard'),
        api('/oracle/calibration').then(v => ({ ok: true, v }), err => ({ ok: false, err })),
      ]);
      setTheses(t?.theses || []);
      setOppMap(o?.map || null);
      setEvidence(e?.evidence || []);
      setGraveyard(g?.graveyard || []);
      if (cal.ok) {
        setCalibration(cal.v);
        setCalError(null);
      } else {
        console.error('[ORACLE] calibration failed:', cal.err);
        setCalError(cal.err?.message || 'Failed to load calibration');
      }
      setLastCycleAt(t?.last_cycle_at || null);
    } catch (err) {
      console.error('[ORACLE] load failed:', err);
      setError(err?.message || 'Failed to load ORACLE data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  function runCycle() {
    setActionError(null);
    api('/oracle/cycle/run', { method: 'POST', body: JSON.stringify({}) })
      .then(fetchAll)
      .catch((err) => {
        console.error('[ORACLE] run cycle failed:', err);
        setActionError(`Could not start ORACLE cycle: ${err?.message || 'unknown error'}`);
      });
  }

  const firstLoad = loading && theses.length === 0 && !error;
  if (firstLoad) return (
    <div role="status" style={{ padding: 24, fontFamily: 'IBM Plex Mono', fontSize: 11, color: 'var(--t3)' }}>
      Loading ORACLE data...
    </div>
  );
  if (error && theses.length === 0 && !oppMap && evidence.length === 0) {
    return <ErrorState error={error} onRetry={fetchAll} title="Could not load ORACLE data" />;
  }

  return (
    <div style={{ padding: '24px', maxWidth: 1400, margin: '0 auto' }}>
      {error && <ErrorState error={error} onRetry={fetchAll} title="Refresh failed — showing the last loaded data" />}
      {actionError && <ErrorState error={actionError} title="Action failed" />}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16,
        borderBottom: '1px solid var(--border-1)' }}>
        {['theses', 'calibration'].map(tab => (
          <button type="button" key={tab} aria-pressed={activeTab === tab} onClick={() => setActiveTab(tab)} style={{
            padding: '8px 16px', background: 'transparent', border: 'none',
            borderBottom: activeTab === tab ? '2px solid var(--oc)' : '2px solid transparent',
            color: activeTab === tab ? 'var(--oc)' : 'var(--t3)',
            cursor: 'pointer', fontFamily: 'IBM Plex Mono', fontSize: 10,
            letterSpacing: '1px', textTransform: 'uppercase',
            transition: 'all 150ms ease', marginBottom: -1,
          }}>
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'calibration' ? (
        <CalibrationPanel calibration={calibration} error={calError} onRetry={fetchAll} />
      ) : (
      <>

      {/* Top row: Thesis list + Opportunity Map */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))', gap: 12, marginBottom: 12 }}>

        {/* Active Theses */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <PanelTitle>Active Theses ({theses.length})</PanelTitle>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {lastCycleAt && <LastRunBadge ts={lastCycleAt} />}
              <button
                type="button"
                onClick={runCycle}
                style={runButtonStyle}
              >
                RUN CYCLE
              </button>
            </div>
          </div>
          {theses.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {theses.map(t => (
                <ThesisCard key={t.thesis_id} thesis={t}
                  onClick={() => setSelected(t)} />
              ))}
            </div>
          ) : (
            <EmptyState message="No active theses. Run ORACLE cycle to generate theses from current market evidence." />
          )}
        </div>

        {/* Opportunity Map */}
        <div style={panelStyle}>
          <PanelTitle>Opportunity Map</PanelTitle>
          {oppMap ? (
            <OppMapPanel map={oppMap} />
          ) : (
            <EmptyState message="No opportunity map yet. Generated after synthesis agent runs." />
          )}
        </div>
      </div>

      {/* Bottom row: Evidence + Graveyard */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 12 }}>

        {/* Evidence Feed */}
        <div style={panelStyle}>
          <PanelTitle>Evidence Feed</PanelTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 400, overflowY: 'auto' }}>
            {evidence.length > 0 ? evidence.map(e => (
              <EvidenceItem key={e.id} item={e} />
            )) : (
              <EmptyState message="No evidence yet. Run ingestion to populate." />
            )}
          </div>
        </div>

        {/* Graveyard */}
        <div style={panelStyle}>
          <PanelTitle>Graveyard ({graveyard.length})</PanelTitle>
          {graveyard.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {graveyard.slice(0, 5).map(g => (
                <GraveyardItem key={g.id} item={g} />
              ))}
            </div>
          ) : (
            <EmptyState message="No retired theses yet." />
          )}
        </div>
      </div>

      {/* Thesis detail side panel */}
      {selected && (
        <ThesisDetailPanel thesis={selected} onClose={() => setSelected(null)} onRetired={fetchAll} />
      )}
      </>
      )}
    </div>
  );
}

// ── Thesis Card ───────────────────────────────────────────────────────────────
function ThesisCard({ thesis, onClick }) {
  const dirColour = thesis.direction === 'bull' ? 'var(--profit)'
                  : thesis.direction === 'bear' ? 'var(--loss)'
                  : 'var(--t3)';
  const conviction = parseFloat(thesis.conviction);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open thesis ${thesis.name}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        padding: '10px 12px',
        background: 'var(--elevated)',
        borderRadius: 6,
        border: '1px solid var(--border-1)',
        cursor: 'pointer',
        transition: 'border-color 150ms ease',
        borderLeft: `3px solid ${dirColour}`,
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border-3)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-1)'}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontFamily: 'IBM Plex Mono', fontWeight: 600, fontSize: 12, color: 'var(--t1)', flex: 1 }}>
          {thesis.name}
        </span>
        <span style={{ fontFamily: 'IBM Plex Mono', fontWeight: 600, fontSize: 11, color: conviction >= 8 ? 'var(--profit)' : conviction >= 6 ? 'var(--warn)' : 'var(--t3)' }}>
          {Number.isFinite(conviction) ? conviction.toFixed(1) : '—'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 9, color: dirColour, textTransform: 'uppercase' }}>
          {thesis.direction}
        </span>
        <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 9, color: 'var(--t4)', textTransform: 'uppercase' }}>
          {thesis.time_horizon}
        </span>
        <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 9, color: 'var(--ai)', textTransform: 'uppercase', marginLeft: 'auto' }}>
          {thesis.domain}
        </span>
      </div>
      <AccuracyBadge trades={parseInt(thesis.accuracy_trades) || 0} wins={parseInt(thesis.accuracy_wins) || 0} />
    </div>
  );
}

// ── Opportunity Map Panel ─────────────────────────────────────────────────────
function OppMapPanel({ map }) {
  let opps = map?.opportunities;
  if (!opps) return <EmptyState message="No opportunities ranked" />;
  if (typeof opps === 'string') {
    try {
      opps = JSON.parse(opps);
    } catch (err) {
      console.warn('[ORACLE] opportunity map is not valid JSON:', err?.message || err);
      return <ErrorState error="The opportunity map could not be parsed" title="Opportunity map unreadable" />;
    }
  }
  if (!Array.isArray(opps) || opps.length === 0) return <EmptyState message="No opportunities ranked" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {opps.slice(0, 6).map((opp, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 0', borderBottom: '1px solid var(--border-0)',
        }}>
          <span style={{
            fontFamily: 'IBM Plex Mono', fontSize: 10,
            color: 'var(--t4)', minWidth: 16,
          }}>
            {opp.rank || i + 1}
          </span>
          <span style={{ fontFamily: 'IBM Plex Mono', fontWeight: 600, fontSize: 13, color: 'var(--t1)', minWidth: 48 }}>
            {opp.asset}
          </span>
          <span style={{
            fontFamily: 'IBM Plex Mono', fontSize: 9,
            color: opp.direction === 'bull' ? 'var(--profit)' : 'var(--loss)',
            textTransform: 'uppercase',
          }}>
            {opp.action}
          </span>
          <span style={{
            fontFamily: 'Outfit', fontSize: 11, color: 'var(--t3)',
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {opp.one_line}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Evidence Item ─────────────────────────────────────────────────────────────
function EvidenceItem({ item }) {
  const sentimentColour = item.sentiment === 'bullish' ? 'var(--profit)'
                        : item.sentiment === 'bearish' ? 'var(--loss)'
                        : 'var(--t4)';
  return (
    <div style={{
      padding: '8px 0',
      borderBottom: '1px solid var(--border-0)',
      display: 'flex', gap: 8, alignItems: 'flex-start',
    }}>
      <div style={{
        width: 2, flexShrink: 0, alignSelf: 'stretch',
        background: sentimentColour, borderRadius: 2, minHeight: 16,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'Outfit', fontSize: 12, color: 'var(--t2)',
          lineHeight: 1.4, marginBottom: 2,
          overflow: 'hidden', display: '-webkit-box',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }}>
          {item.headline}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 8, color: 'var(--t4)' }}>
            {item.source_name}
          </span>
          {parseFloat(item.relevance_score) > 0 && (
            <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 8, color: 'var(--t4)' }}>
              rel {parseFloat(item.relevance_score).toFixed(1)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Graveyard Item ────────────────────────────────────────────────────────────
function GraveyardItem({ item }) {
  const outcomeColour = item.outcome === 'correct' ? 'var(--profit)'
                      : item.outcome === 'incorrect' ? 'var(--loss)'
                      : 'var(--warn)';
  return (
    <div style={{
      padding: '8px 0', borderBottom: '1px solid var(--border-0)',
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
        <span style={{ fontFamily: 'Outfit', fontSize: 12, color: 'var(--t3)', flex: 1 }}>
          {item.thesis_name}
        </span>
        {item.outcome && (
          <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 9, color: outcomeColour }}>
            {item.outcome}
          </span>
        )}
      </div>
      {item.key_learning && (
        <div style={{ fontFamily: 'Outfit', fontSize: 11, color: 'var(--t4)', lineHeight: 1.4 }}>
          {item.key_learning}
        </div>
      )}
    </div>
  );
}

// ── Thesis Detail Side Panel ──────────────────────────────────────────────────
// Opened thesis: shared DetailPanel (>= 680px on desktop, resizable, expandable, 100vw on phones)
function ThesisDetailPanel({ thesis, onClose, onRetired }) {
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [retiring, setRetiring] = useState(false);
  const [retireError, setRetireError] = useState(null);

  const loadDetail = useCallback(() => {
    setDetailError(null);
    api(`/oracle/theses/${thesis.thesis_id}`)
      .then(r => setDetail(r))
      .catch((err) => {
        console.error('[ORACLE] thesis detail failed:', err);
        setDetailError(err?.message || 'Failed to load thesis history');
      });
  }, [thesis.thesis_id]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  async function retire() {
    setRetiring(true);
    setRetireError(null);
    try {
      await api(`/oracle/theses/${thesis.thesis_id}/retire`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Manual retirement' }),
      });
      onRetired();
      onClose();
    } catch (err) {
      console.error('[ORACLE] retire failed:', err);
      setRetireError(err?.message || 'Could not retire thesis');
    }
    setRetiring(false);
  }

  const dirColour = thesis.direction === 'bull' ? 'var(--profit)'
                  : thesis.direction === 'bear' ? 'var(--loss)'
                  : 'var(--t3)';

  return (
    <DetailPanel open onClose={onClose} title="ORACLE Thesis" ariaLabel={`Thesis: ${thesis.name}`} zIndex={1002}>
      <div>
        <h2 style={{
          fontFamily: 'Instrument Sans', fontWeight: 600, fontSize: 16,
          color: 'var(--t1)', marginBottom: 8, lineHeight: 1.3,
        }}>
          {thesis.name}
        </h2>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <Badge color={dirColour}>{thesis.direction?.toUpperCase()}</Badge>
          <Badge color="var(--ai)">{thesis.domain}</Badge>
          <Badge color="var(--t3)">{thesis.time_horizon}</Badge>
          <Badge color={parseFloat(thesis.conviction) >= 8 ? 'var(--cyan)' : 'var(--warn)'}>
            {Number.isFinite(parseFloat(thesis.conviction)) ? `${parseFloat(thesis.conviction).toFixed(1)}/10` : '—'}
          </Badge>
        </div>

        <DetailSection title="Summary">{thesis.summary}</DetailSection>
        {thesis.catalyst    && <DetailSection title="Catalyst">{thesis.catalyst}</DetailSection>}
        {thesis.invalidation && <DetailSection title="Invalidation">{thesis.invalidation}</DetailSection>}
        {thesis.competing_view && <DetailSection title="Counter-Argument">{thesis.competing_view}</DetailSection>}

        {thesis.long_assets?.length > 0 && (
          <DetailSection title="Long">
            {thesis.long_assets.join(', ')}
          </DetailSection>
        )}
        {thesis.short_assets?.length > 0 && (
          <DetailSection title="Short">
            {thesis.short_assets.join(', ')}
          </DetailSection>
        )}

        {detailError && <ErrorState error={detailError} onRetry={loadDetail} title="Could not load conviction history" />}
        {detail?.conviction_history?.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontFamily: 'Instrument Sans', fontWeight: 600, fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>
              Conviction History
            </div>
            {detail.conviction_history.map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, fontSize: 11 }}>
                <span style={{ fontFamily: 'IBM Plex Mono', color: 'var(--t4)' }}>
                  {h.old_conviction} → {h.new_conviction}
                </span>
                <span style={{ fontFamily: 'Outfit', color: 'var(--t3)', flex: 1 }}>
                  {h.reason}
                </span>
              </div>
            ))}
          </div>
        )}

        {retireError && <ErrorState error={retireError} title="Could not retire thesis" />}
        <button
          type="button"
          onClick={retire}
          disabled={retiring}
          style={{
            marginTop: 24, width: '100%',
            background: 'transparent', border: '1px solid var(--border-2)',
            color: 'var(--t3)', cursor: 'pointer', padding: '8px 16px',
            borderRadius: 4, fontFamily: 'IBM Plex Mono', fontSize: 9,
            letterSpacing: '1px', textTransform: 'uppercase',
            opacity: retiring ? 0.5 : 1,
          }}
        >
          {retiring ? 'RETIRING…' : 'RETIRE THESIS'}
        </button>
      </div>
    </DetailPanel>
  );
}

// ── Calibration Panel ────────────────────────────────────────────────────────
function CalibrationPanel({ calibration, error, onRetry }) {
  if (error && !calibration) return <ErrorState error={error} onRetry={onRetry} title="Could not load calibration" />;
  if (!calibration) return <EmptyState message="No calibration data yet. Run Graveyard Auditor to generate." />;

  const { multipliers, stats, learnings } = calibration;
  const domains = ['macro', 'geopolitical', 'technology', 'commodity', 'equity', 'crypto'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Domain accuracy grid */}
      <div style={panelStyle}>
        <PanelTitle>Domain Calibration</PanelTitle>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 8,
        }}>
          {domains.map(domain => {
            const stat = stats?.find(s => s.domain === domain);
            const parsedMult = parseFloat(multipliers?.[domain]);
            const mult = Number.isFinite(parsedMult) ? parsedMult : 1.0;
            const acc  = stat ? parseFloat(stat.directional_accuracy || 0) : null;

            const multColour = mult > 1.0 ? 'var(--profit)'
                             : mult < 1.0 ? 'var(--warn)'
                             : 'var(--t3)';

            return (
              <div key={domain} style={{
                background: 'var(--elevated)',
                borderRadius: 6, padding: '10px 12px',
                border: '1px solid var(--border-1)',
              }}>
                <div style={{
                  fontFamily: 'IBM Plex Mono', fontWeight: 600,
                  fontSize: 9, color: 'var(--oc)',
                  textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8,
                }}>
                  {domain}
                </div>
                <div style={{
                  fontFamily: 'IBM Plex Mono', fontWeight: 300,
                  fontSize: 22, color: 'var(--t1)', marginBottom: 4,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {acc !== null ? `${acc.toFixed(0)}%` : '\u2014'}
                </div>
                <div style={{ fontFamily: 'Outfit', fontSize: 10, color: 'var(--t3)' }}>
                  directional accuracy
                </div>
                <div style={{
                  marginTop: 6,
                  fontFamily: 'IBM Plex Mono', fontSize: 10,
                  color: multColour,
                }}>
                  {'\u00d7'}{mult.toFixed(2)} conviction mult.
                </div>
                {stat && (
                  <div style={{
                    fontFamily: 'IBM Plex Mono', fontSize: 8,
                    color: 'var(--t4)', marginTop: 4,
                  }}>
                    {stat.theses_retired} retired
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent learnings */}
      {learnings?.length > 0 && (
        <div style={panelStyle}>
          <PanelTitle>Recent Learnings ({learnings.length})</PanelTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {learnings.slice(0, 10).map((l, i) => (
              <div key={i} style={{
                padding: '8px 12px', background: 'var(--elevated)',
                borderRadius: 6, borderLeft: '2px solid var(--ai)',
              }}>
                <div style={{
                  fontFamily: 'IBM Plex Mono', fontSize: 9,
                  color: 'var(--ai)', marginBottom: 4,
                  textTransform: 'uppercase', letterSpacing: '1px',
                }}>
                  {l.domain} · {l.learning_type?.replace(/_/g, ' ')}
                </div>
                <div style={{ fontFamily: 'Outfit', fontSize: 12, color: 'var(--t2)', lineHeight: 1.4 }}>
                  {l.summary}
                </div>
                {l.adjustment_rule && (
                  <div style={{
                    fontFamily: 'IBM Plex Mono', fontSize: 10,
                    color: 'var(--t4)', marginTop: 4,
                    borderTop: '1px solid var(--border-0)', paddingTop: 4,
                  }}>
                    Rule: {l.adjustment_rule}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Accuracy Badge ────────────────────────────────────────────────────────────
function AccuracyBadge({ trades, wins }) {
  let colour = 'var(--t4)';
  let label  = '—';

  if (trades === 0) {
    // nothing to show
  } else if (trades <= 2) {
    colour = 'var(--t4)';
    label  = `~50% (${trades} trade${trades > 1 ? 's' : ''})`;
  } else {
    const pct = Math.round((wins / trades) * 100);
    colour = pct >= 60 ? 'var(--profit)' : pct >= 40 ? 'var(--warn)' : 'var(--loss)';
    label  = `${pct}% (${trades} trades)`;
  }

  return (
    <div style={{ marginTop: 5 }}>
      <span style={{
        fontFamily: 'IBM Plex Mono', fontSize: 8,
        color: colour, letterSpacing: '0.5px',
        padding: '2px 5px', borderRadius: 3,
        border: `1px solid color-mix(in srgb, ${colour} 20%, transparent)`,
        background: `color-mix(in srgb, ${colour} 7%, transparent)`,
      }}>
        {label}
      </span>
    </div>
  );
}

// ── Last Run Badge ────────────────────────────────────────────────────────────
function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ago`;
  if (h > 0)   return `${h}h ago`;
  return `${m}m ago`;
}

function LastRunBadge({ ts }) {
  const h     = (Date.now() - new Date(ts).getTime()) / 3600000;
  const stale = h > 12;
  return (
    <span style={{
      fontFamily: 'IBM Plex Mono', fontSize: 8,
      color: stale ? 'var(--warn)' : 'var(--t4)',
      letterSpacing: '0.5px',
    }}>
      LAST RUN: {timeAgo(ts)}
    </span>
  );
}

// ── Shared ────────────────────────────────────────────────────────────────────
const panelStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border-1)',
  borderRadius: 8,
  padding: 16,
};

const runButtonStyle = {
  background: 'transparent',
  border: '1px solid var(--oc-border)',
  color: 'var(--oc)', cursor: 'pointer',
  padding: '4px 10px', borderRadius: 4,
  fontFamily: 'IBM Plex Mono', fontSize: 9,
  letterSpacing: '1px', textTransform: 'uppercase',
};

function PanelTitle({ children }) {
  return (
    <div style={{
      fontFamily: 'Instrument Sans, sans-serif', fontWeight: 600,
      fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase',
      letterSpacing: '1px', marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

function Badge({ color, children }) {
  return (
    <span style={{
      fontFamily: 'IBM Plex Mono', fontWeight: 600,
      fontSize: 9, letterSpacing: '1px',
      color, textTransform: 'uppercase',
      padding: '2px 6px', borderRadius: 3,
      border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
      background: `color-mix(in srgb, ${color} 7%, transparent)`,
    }}>
      {children}
    </span>
  );
}

function DetailSection({ title, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontFamily: 'IBM Plex Mono', fontSize: 9, color: 'var(--t4)',
        textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 4,
      }}>
        {title}
      </div>
      <div style={{ fontFamily: 'Outfit', fontSize: 13, color: 'var(--t2)', lineHeight: 1.5 }}>
        {children}
      </div>
    </div>
  );
}

function EmptyState({ message }) {
  return (
    <div style={{
      padding: '24px 0', textAlign: 'center',
      fontFamily: 'Outfit', fontSize: 12, color: 'var(--t4)',
    }}>
      {message}
    </div>
  );
}
