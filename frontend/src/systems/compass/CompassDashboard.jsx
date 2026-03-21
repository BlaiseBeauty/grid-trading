import { useState, useEffect } from 'react';
import { api } from '../../lib/api';

export default function CompassDashboard() {
  const [portfolio,    setPortfolio]    = useState(null);
  const [risk,         setRisk]         = useState(null);
  const [allocations,  setAllocations]  = useState([]);
  const [rebalance,    setRebalance]    = useState([]);
  const [history,      setHistory]      = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [lastCycleAt,  setLastCycleAt]  = useState(null);
  const [drawdownPct,  setDrawdownPct]  = useState(null);

  useEffect(() => { fetchAll(); }, []);

  async function fetchAll() {
    setLoading(true);
    try {
      const [p, r, a, rb, h] = await Promise.all([
        api('/compass/portfolio'),
        api('/compass/risk'),
        api('/compass/allocations'),
        api('/compass/rebalance'),
        api('/compass/portfolio/history?limit=12'),
      ]);
      setPortfolio(p?.portfolio || null);
      setRisk(r?.assessment || null);
      setAllocations(a?.allocations || []);
      setRebalance(rb?.pending || []);
      setHistory(h?.history || []);
      setLastCycleAt(p?.last_cycle_at || null);
      setDrawdownPct(p?.current_drawdown_pct ?? null);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingState />;

  const postureColour = {
    aggressive: 'var(--profit)',
    neutral:    'var(--t2)',
    defensive:  'var(--warn)',
    cash:       'var(--loss)',
  }[portfolio?.risk_posture] || 'var(--t4)';

  return (
    <div style={{
      padding: '24px',
      maxWidth: 1400,
      margin: '0 auto',
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
      gap: 12,
    }}>

      {/* Panel 1: Portfolio Status */}
      <div style={panelStyle}>
        <PanelTitle>Portfolio Status</PanelTitle>

        {portfolio ? (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'IBM Plex Mono', marginBottom: 4 }}>
                RISK POSTURE
              </div>
              <div style={{
                fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600,
                fontSize: 24, letterSpacing: '2px',
                color: postureColour, textTransform: 'uppercase',
              }}>
                {portfolio.risk_posture}
              </div>
              {lastCycleAt && (
                <div style={{
                  fontFamily: 'IBM Plex Mono', fontSize: 8,
                  color: compassLastRunColour(lastCycleAt),
                  marginTop: 4, letterSpacing: '0.5px',
                }}>
                  {compassLastRunLabel(lastCycleAt)}
                </div>
              )}
              <div style={{
                fontFamily: 'Outfit', fontSize: 12, color: 'var(--t3)',
                marginTop: 6, lineHeight: 1.5,
              }}>
                {portfolio.posture_reasoning}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontFamily: 'Outfit', fontSize: 13, color: 'var(--t2)' }}>
                Cash Buffer
              </span>
              <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 13, color: 'var(--t1)' }}>
                {(parseFloat(portfolio.cash_weight) * 100).toFixed(0)}%
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontFamily: 'Outfit', fontSize: 13, color: 'var(--t2)' }}>
                Drawdown
              </span>
              <span style={{
                fontFamily: 'IBM Plex Mono', fontSize: 13,
                color: drawdownPct === null ? 'var(--t4)'
                     : drawdownPct < 5    ? 'var(--profit)'
                     : drawdownPct <= 10  ? 'var(--warn)'
                     : 'var(--loss)',
              }}>
                {drawdownPct !== null ? `${drawdownPct.toFixed(1)}%` : '—'}
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'Outfit', fontSize: 13, color: 'var(--t2)' }}>
                ORACLE Theses Used
              </span>
              <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 13, color: 'var(--ai)' }}>
                {portfolio.oracle_thesis_count}
              </span>
            </div>
          </>
        ) : (
          <EmptyState message="Run COMPASS cycle to generate portfolio guidance" />
        )}
      </div>

      {/* Panel 2: Risk Assessment */}
      <div style={panelStyle}>
        <PanelTitle>Risk Assessment</PanelTitle>

        {risk ? (
          <>
            <RiskScoreGauge score={parseFloat(risk.risk_score)} />

            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <LimitRow label="Max Position" value={`$${Number(risk.max_single_position_usd).toLocaleString()}`} />
              <LimitRow label="Max Exposure"  value={`$${Number(risk.max_total_exposure_usd).toLocaleString()}`} />
              <LimitRow label="Max Positions" value={risk.max_open_positions} />
              <LimitRow label="SCRAM Threshold" value={`${risk.scram_threshold_pct}%`} />
            </div>

            {risk.flags?.length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(typeof risk.flags === 'string' ? JSON.parse(risk.flags) : risk.flags)
                  .map((flag, i) => (
                    <FlagItem key={i} flag={flag} />
                  ))}
              </div>
            )}
          </>
        ) : (
          <EmptyState message="No risk assessment yet" />
        )}
      </div>

      {/* Panel 3: Symbol Allocations */}
      <div style={panelStyle}>
        <PanelTitle>Allocations</PanelTitle>
        {allocations.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {allocations.map(a => (
              <AllocationRow key={a.id} allocation={a} />
            ))}
          </div>
        ) : (
          <EmptyState message="No active allocations" />
        )}
      </div>

      {/* Panel 4: Rebalance Recommendations */}
      {rebalance.length > 0 && (
        <div style={{ ...panelStyle, gridColumn: '1 / -1' }}>
          <PanelTitle>Rebalance Recommendations ({rebalance.length})</PanelTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rebalance.map(r => (
              <RebalanceItem key={r.id} item={r} onAcknowledge={() => {
                api(`/compass/rebalance/${r.id}/acknowledge`, {
                  method: 'POST',
                  body: JSON.stringify({}),
                }).then(fetchAll);
              }} />
            ))}
          </div>
        </div>
      )}

      {/* Panel 5: Posture History */}
      <div style={{ ...panelStyle, gridColumn: '1 / -1' }}>
        <PanelTitle>Posture History</PanelTitle>
        <PostureHistory history={history} />
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function RiskScoreGauge({ score }) {
  const colour = score <= 3 ? 'var(--profit)' : score <= 6 ? 'var(--warn)' : 'var(--loss)';
  const label  = score <= 3 ? 'LOW' : score <= 6 ? 'MODERATE' : 'HIGH';
  const pct    = (score / 10) * 100;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 11, color: 'var(--t3)' }}>RISK SCORE</span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontFamily: 'IBM Plex Mono', fontWeight: 300, fontSize: 28, color: colour }}>
            {score.toFixed(1)}
          </span>
          <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 10, color: colour }}>{label}</span>
        </div>
      </div>
      <div style={{ height: 4, background: 'var(--elevated)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`,
          background: colour, borderRadius: 2,
          transition: 'width 600ms ease',
        }} />
      </div>
    </div>
  );
}

function LimitRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontFamily: 'Outfit', fontSize: 12, color: 'var(--t3)' }}>{label}</span>
      <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 12, color: 'var(--t1)' }}>{value}</span>
    </div>
  );
}

function FlagItem({ flag }) {
  const colour = flag.severity === 'critical' ? 'var(--loss)'
               : flag.severity === 'warn'     ? 'var(--warn)'
               : 'var(--t3)';
  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'flex-start',
      padding: '6px 8px', background: 'var(--elevated)',
      borderRadius: 4, borderLeft: `2px solid ${colour}`,
    }}>
      <span style={{ fontFamily: 'Outfit', fontSize: 11, color: 'var(--t2)', lineHeight: 1.4 }}>
        {flag.message}
      </span>
    </div>
  );
}

function AllocationRow({ allocation }) {
  const dirColour = allocation.direction_bias === 'long'    ? 'var(--profit)'
                  : allocation.direction_bias === 'short'   ? 'var(--loss)'
                  : 'var(--t3)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '8px 0', borderBottom: '1px solid var(--border-0)',
    }}>
      <span style={{ fontFamily: 'IBM Plex Mono', fontWeight: 600, fontSize: 13, color: 'var(--t1)', minWidth: 48 }}>
        {allocation.symbol}
      </span>
      <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 10, color: dirColour, textTransform: 'uppercase' }}>
        {allocation.direction_bias || 'neutral'}
      </span>
      <span style={{ fontFamily: 'IBM Plex Mono', fontSize: 12, color: 'var(--t2)', marginLeft: 'auto' }}>
        max ${Number(allocation.max_position_usd).toLocaleString()}
      </span>
    </div>
  );
}

function RebalanceItem({ item, onAcknowledge }) {
  const urgencyColour = item.urgency === 'critical' ? 'var(--loss)'
                      : item.urgency === 'high'     ? 'var(--warn)'
                      : 'var(--t3)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 12px', background: 'var(--elevated)',
      borderRadius: 6, borderLeft: `2px solid ${urgencyColour}`,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: 'IBM Plex Mono', fontSize: 10, color: urgencyColour, marginBottom: 3 }}>
          {item.action?.toUpperCase().replace(/_/g, ' ')}
          {item.symbol && ` · ${item.symbol}`}
        </div>
        <div style={{ fontFamily: 'Outfit', fontSize: 12, color: 'var(--t2)' }}>
          {item.reason}
        </div>
      </div>
      <button
        onClick={onAcknowledge}
        style={{
          background: 'transparent', border: '1px solid var(--border-2)',
          color: 'var(--t3)', cursor: 'pointer', padding: '4px 10px',
          borderRadius: 4, fontFamily: 'IBM Plex Mono', fontSize: 9,
          letterSpacing: '1px', textTransform: 'uppercase',
          flexShrink: 0,
        }}
      >
        ACK
      </button>
    </div>
  );
}

function PostureHistory({ history }) {
  if (!history.length) return <EmptyState message="No history yet" />;

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {history.map(h => {
        const colour = {
          aggressive: 'var(--profit)', neutral: 'var(--t3)',
          defensive: 'var(--warn)', cash: 'var(--loss)',
        }[h.risk_posture] || 'var(--t4)';
        return (
          <div key={h.id} style={{
            padding: '6px 10px', background: 'var(--elevated)',
            borderRadius: 4, border: '1px solid var(--border-1)',
            minWidth: 80, textAlign: 'center',
          }}>
            <div style={{ fontFamily: 'IBM Plex Mono', fontSize: 9, color: colour, marginBottom: 2 }}>
              {h.risk_posture?.toUpperCase()}
            </div>
            <div style={{ fontFamily: 'IBM Plex Mono', fontSize: 8, color: 'var(--t4)' }}>
              {new Date(h.created_at).toLocaleDateString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Last-run helpers ───────────────────────────────────────────────────────────
function compassTimeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ago`;
  if (h > 0)   return `${h}h ago`;
  return `${m}m ago`;
}

function compassLastRunColour(ts) {
  const h = (Date.now() - new Date(ts).getTime()) / 3600000;
  return h > 12 ? 'var(--warn)' : 'var(--t4)';
}

function compassLastRunLabel(ts) {
  const h = (Date.now() - new Date(ts).getTime()) / 3600000;
  return h > 12
    ? `LAST RUN: ${compassTimeAgo(ts)} · STALE`
    : `LAST RUN: ${compassTimeAgo(ts)}`;
}

// ── Shared ─────────────────────────────────────────────────────────────────────
const panelStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border-1)',
  borderRadius: 8,
  padding: 16,
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

function LoadingState() {
  return (
    <div style={{
      padding: 24, display: 'flex', justifyContent: 'center',
      fontFamily: 'IBM Plex Mono', fontSize: 11, color: 'var(--t4)',
    }}>
      Loading COMPASS data...
    </div>
  );
}
