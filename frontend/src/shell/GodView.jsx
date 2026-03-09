import { useEffect } from 'react';
import usePlatformStore from '../stores/platform';
import { api } from '../lib/api';

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
  } = usePlatformStore();

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  async function fetchAll() {
    try {
      const [theses, regime, portfolio, risk, health, costs] = await Promise.allSettled([
        api('/oracle/theses'),
        api('/oracle/macro-regime'),
        api('/compass/portfolio'),
        api('/compass/risk'),
        api('/platform/health'),
        api('/platform/costs/summary'),
      ]);

      if (theses.status === 'fulfilled')    setOracleTheses(theses.value?.theses || []);
      if (regime.status === 'fulfilled')    setOracleRegime(regime.value?.regime || null);
      if (portfolio.status === 'fulfilled') setCompassPortfolio(portfolio.value?.portfolio || null);
      if (risk.status === 'fulfilled')      setCompassRisk(risk.value?.assessment || null);
      if (health.status === 'fulfilled')    setPlatformHealth(health.value || null);
      if (costs.status === 'fulfilled')     setMonthlyCostUsd(costs.value?.month_to_date?.total_usd || null);
    } catch { /* silent fail — God View is enhancement only */ }
  }

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
      <OracleStrip theses={oracleTheses} regime={oracleRegime} />

      <div style={{ background: 'var(--border-1)' }} />

      {/* COMPASS strip */}
      <CompassStrip portfolio={compassPortfolio} risk={compassRisk} />

      <div style={{ background: 'var(--border-1)' }} />

      {/* GRID strip */}
      <GridStrip health={platformHealth} />
    </div>
  );
}

// ── ORACLE strip ──────────────────────────────────────────────────────────────
function OracleStrip({ theses, regime }) {
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
      ) : (
        <span style={{
          fontFamily: 'Outfit, sans-serif', fontSize: 11,
          color: 'var(--t4)',
        }}>
          {theses === null ? '—' : 'No active theses'}
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
function CompassStrip({ portfolio, risk }) {
  const posture    = portfolio?.risk_posture || null;
  const riskScore  = risk?.risk_score !== undefined ? parseFloat(risk.risk_score) : null;
  const maxPos     = risk?.max_single_position_usd;

  const postureColour = {
    aggressive: 'var(--profit)',
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
        ) : (
          <span style={{ fontFamily: 'Outfit, sans-serif', fontSize: 11, color: 'var(--t4)' }}>
            Not initialised
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

      {maxPos && (
        <span style={{
          fontFamily: 'IBM Plex Mono, monospace', fontSize: 9,
          color: 'var(--t4)',
        }}>
          MAX POS ${Number(maxPos).toLocaleString()}
        </span>
      )}
    </div>
  );
}

// ── GRID strip ────────────────────────────────────────────────────────────────
function GridStrip({ health }) {
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
        <span style={{
          fontFamily: 'Outfit, sans-serif', fontSize: 12, color: 'var(--t2)',
        }}>
          Last cycle: <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
            {lastCycleLabel}
          </span>
        </span>
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
  const colour = c >= 8 ? 'var(--profit)' : c >= 6 ? 'var(--warn)' : 'var(--t3)';
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
