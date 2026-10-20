import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import usePlatformStore from '../stores/platform';
import { api } from '../lib/api';
import { fmtMoney } from '../lib/format';

// Inline "unavailable + retry" line for a strip whose data failed to load
function StripError({ message, onRetry }) {
  return (
    <span role="alert" style={{ fontFamily: 'Outfit, sans-serif', fontSize: 11, color: 'var(--warn)' }}>
      Unavailable{' '}
      <button
        type="button"
        onClick={onRetry}
        title={message}
        style={{ color: 'var(--cyan)', fontSize: 11, textDecoration: 'underline' }}
      >
        retry
      </button>
    </span>
  );
}

// Refresh God View data every 5 minutes
const REFRESH_INTERVAL = 5 * 60 * 1000;

export default function GodView() {
  const {
    oracleTheses, setOracleTheses,
    oracleRegime, setOracleRegime,
    compassPortfolio, setCompassPortfolio,
    compassRisk, setCompassRisk,
    platformHealth, setPlatformHealth,
    setMonthlyCostUsd,
    godViewTick,
  } = usePlatformStore(useShallow(s => ({
    oracleTheses: s.oracleTheses, setOracleTheses: s.setOracleTheses,
    oracleRegime: s.oracleRegime, setOracleRegime: s.setOracleRegime,
    compassPortfolio: s.compassPortfolio, setCompassPortfolio: s.setCompassPortfolio,
    compassRisk: s.compassRisk, setCompassRisk: s.setCompassRisk,
    platformHealth: s.platformHealth, setPlatformHealth: s.setPlatformHealth,
    setMonthlyCostUsd: s.setMonthlyCostUsd,
    godViewTick: s.godViewTick,
  })));

  // Per-strip { loaded, error }: a failed fetch must read as "unavailable", never as "nothing here"
  const [status, setStatus] = useState({
    oracle: { loaded: false, error: null },
    compass: { loaded: false, error: null },
    health: { loaded: false, error: null },
  });

  const fetchAll = useCallback(async () => {
    const results = await Promise.allSettled([
      api('/oracle/theses'),
      api('/oracle/macro-regime'),
      api('/compass/portfolio'),
      api('/compass/risk'),
      api('/platform/health'),
      api('/platform/costs/summary'),
    ]);
    const [theses, regime, portfolio, risk, health, costs] = results;

    if (theses.status === 'fulfilled')    setOracleTheses(theses.value?.theses || []);
    if (regime.status === 'fulfilled')    setOracleRegime(regime.value?.regime || null);
    if (portfolio.status === 'fulfilled') setCompassPortfolio(portfolio.value?.portfolio || null);
    if (risk.status === 'fulfilled')      setCompassRisk(risk.value?.assessment || null);
    if (health.status === 'fulfilled')    setPlatformHealth(health.value || null);
    if (costs.status === 'fulfilled')     setMonthlyCostUsd(costs.value?.month_to_date?.total_usd ?? null);

    for (const r of results) {
      if (r.status === 'rejected') console.error('[GodView] fetch failed:', r.reason?.message || r.reason);
    }
    const errOf = (...rs) => {
      const failed = rs.find(r => r.status === 'rejected');
      return failed ? (failed.reason?.message || 'Request failed') : null;
    };
    setStatus(prev => ({
      oracle: { loaded: prev.oracle.loaded || theses.status === 'fulfilled', error: errOf(theses, regime) },
      compass: { loaded: prev.compass.loaded || portfolio.status === 'fulfilled', error: errOf(portfolio, risk) },
      health: { loaded: prev.health.loaded || health.status === 'fulfilled', error: errOf(health) },
    }));
  }, [setOracleTheses, setOracleRegime, setCompassPortfolio, setCompassRisk, setPlatformHealth, setMonthlyCostUsd]);

  // Initial load, 5-minute refresh, and an immediate refresh when a bus event bumps godViewTick
  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchAll, godViewTick]);

  return (
    <div style={{
      position: 'fixed',
      top: 'var(--shell-switcher-height)',
      left: 0,
      right: 0,
      height: 'var(--shell-god-view-height)',
      background: 'var(--void)',
      borderBottom: '1px solid var(--border-1)',
      display: 'grid',
      gridTemplateColumns: '1fr 1px 1fr 1px 1fr',
      zIndex: 999,
      overflow: 'hidden',
    }}>

      {/* ORACLE strip */}
      <OracleStrip theses={oracleTheses} regime={oracleRegime} status={status.oracle} onRetry={fetchAll} />

      <div style={{ background: 'var(--border-1)' }} />

      {/* COMPASS strip */}
      <CompassStrip portfolio={compassPortfolio} risk={compassRisk} status={status.compass} onRetry={fetchAll} />

      <div style={{ background: 'var(--border-1)' }} />

      {/* GRID strip */}
      <GridStrip health={platformHealth} status={status.health} onRetry={fetchAll} />
    </div>
  );
}

// ── ORACLE strip ──────────────────────────────────────────────────────────────
function OracleStrip({ theses, regime, status, onRetry }) {
  const topThesis  = theses?.[0];
  const regimeLabel = regime?.payload?.overall || regime?.overall || null;

  return (
    <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: 'var(--oc)', flexShrink: 0,
        }} />
        <span style={{
          fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600,
          fontSize: 9, letterSpacing: '1.5px', color: 'var(--oc)',
          textTransform: 'uppercase',
        }}>
          ORACLE
        </span>
        {regimeLabel && (
          <span style={{
            fontFamily: 'IBM Plex Mono, monospace', fontSize: 9,
            color: 'var(--t3)', marginLeft: 'auto',
          }}>
            {regimeLabel}
          </span>
        )}
      </div>

      {topThesis ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <DirectionArrow direction={topThesis.direction} />
          <span style={{
            fontFamily: 'Outfit, sans-serif', fontSize: 12,
            color: 'var(--t2)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
          }}>
            {topThesis.payload?.name || topThesis.name || 'Active thesis'}
          </span>
          <ConvictionBadge conviction={topThesis.conviction} />
        </div>
      ) : status.error && !status.loaded ? (
        <StripError message={status.error} onRetry={onRetry} />
      ) : (
        <span style={{
          fontFamily: 'Outfit, sans-serif', fontSize: 11,
          color: 'var(--t3)',
        }}>
          {!status.loaded ? '—' : 'No active theses'}
        </span>
      )}

      {theses?.length > 1 && (
        <span style={{
          fontFamily: 'IBM Plex Mono, monospace', fontSize: 9,
          color: 'var(--t4)',
        }}>
          +{theses.length - 1} more
        </span>
      )}
    </div>
  );
}

// ── COMPASS strip ─────────────────────────────────────────────────────────────
function CompassStrip({ portfolio, risk, status, onRetry }) {
  const posture    = portfolio?.risk_posture || null;
  const rawScore   = risk?.risk_score !== undefined ? parseFloat(risk.risk_score) : null;
  const riskScore  = Number.isFinite(rawScore) ? rawScore : null;
  const maxPos     = parseFloat(risk?.max_single_position_usd);

  // Green is reserved for profit/loss, so an aggressive posture uses the UI cyan
  const postureColour = {
    aggressive: 'var(--cyan)',
    neutral:    'var(--t2)',
    defensive:  'var(--warn)',
    cash:       'var(--loss)',
  }[posture] || 'var(--t4)';

  const riskColour = riskScore === null ? 'var(--t4)'
    : riskScore <= 3 ? 'var(--risk-low)'
    : riskScore <= 6 ? 'var(--risk-med)'
    : 'var(--risk-high)';

  return (
    <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: 'var(--cc)', flexShrink: 0,
        }} />
        <span style={{
          fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600,
          fontSize: 9, letterSpacing: '1.5px', color: 'var(--cc)',
          textTransform: 'uppercase',
        }}>
          COMPASS
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {posture ? (
          <span style={{
            fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600,
            fontSize: 11, letterSpacing: '1px',
            color: postureColour, textTransform: 'uppercase',
          }}>
            {posture}
          </span>
        ) : status.error && !status.loaded ? (
          <StripError message={status.error} onRetry={onRetry} />
        ) : (
          <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: 11, color: 'var(--t3)' }}>
            {!status.loaded ? '—' : 'Not initialised'}
          </span>
        )}

        {riskScore !== null && (
          <span style={{
            fontFamily: 'IBM Plex Mono, monospace', fontSize: 10,
            color: riskColour, marginLeft: 'auto',
          }}>
            RISK {riskScore.toFixed(1)}/10
          </span>
        )}
      </div>

      {maxPos > 0 && (
        <span style={{
          fontFamily: 'IBM Plex Mono, monospace', fontSize: 9,
          color: 'var(--t3)',
        }}>
          MAX POS {fmtMoney(maxPos, 0)}
        </span>
      )}
    </div>
  );
}

// ── GRID strip ────────────────────────────────────────────────────────────────
function GridStrip({ health, status, onRetry }) {
  const gridHealth   = health?.systems?.grid;
  const lastCycle    = gridHealth?.last_cycle_at;
  const busEvents24h = health?.intelligence_bus?.events_24h;

  let lastCycleLabel = '—';
  if (lastCycle) {
    const mins = Math.round((Date.now() - new Date(lastCycle)) / 60000);
    lastCycleLabel = mins < 60 ? `${mins}m ago` : `${Math.round(mins/60)}h ago`;
  }

  return (
    <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: 'var(--gc)', flexShrink: 0,
        }} />
        <span style={{
          fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600,
          fontSize: 9, letterSpacing: '1.5px', color: 'var(--gc)',
          textTransform: 'uppercase',
        }}>
          EXECUTE
        </span>
        <SystemStatusDot status={gridHealth?.status} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {status.error && !status.loaded ? (
          <StripError message={status.error} onRetry={onRetry} />
        ) : (
          <span style={{
            fontFamily: 'Outfit, sans-serif', fontSize: 12, color: 'var(--t2)',
          }}>
            Last cycle: <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
              {lastCycleLabel}
            </span>
          </span>
        )}
      </div>

      {busEvents24h !== undefined && (
        <span style={{
          fontFamily: 'IBM Plex Mono, monospace', fontSize: 9,
          color: 'var(--t4)',
        }}>
          {busEvents24h} BUS EVENTS 24H
        </span>
      )}
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────
function DirectionArrow({ direction }) {
  const colour = direction === 'bull' ? 'var(--profit)'
               : direction === 'bear' ? 'var(--loss)'
               : 'var(--t3)';
  const symbol = direction === 'bull' ? '▲' : direction === 'bear' ? '▼' : '◆';
  return <span style={{ color: colour, fontSize: 9, flexShrink: 0 }}>{symbol}</span>;
}

function ConvictionBadge({ conviction }) {
  const c = parseFloat(conviction);
  if (isNaN(c)) return null;
  const colour = c >= 8 ? 'var(--cyan)' : c >= 6 ? 'var(--warn)' : 'var(--t3)';
  return (
    <span style={{
      fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600,
      fontSize: 9, color: colour, flexShrink: 0,
    }}>
      {c.toFixed(1)}
    </span>
  );
}

function SystemStatusDot({ status }) {
  const colour = status === 'healthy' ? 'var(--profit)'
               : status === 'degraded' ? 'var(--warn)'
               : status === 'down' ? 'var(--loss)'
               : 'var(--t4)';
  return (
    <div style={{
      width: 5, height: 5, borderRadius: '50%',
      background: colour, marginLeft: 'auto',
    }} />
  );
}
