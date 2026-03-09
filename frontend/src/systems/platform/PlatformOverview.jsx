import { useEffect, useState } from 'react';
import usePlatformStore from '../../stores/platform';
import { api } from '../../lib/api';

export default function PlatformOverview() {
  const { platformHealth, oracleTheses, compassPortfolio, compassRisk } = usePlatformStore();
  const [costs, setCosts] = useState(null);
  const [busStats, setBusStats] = useState(null);

  useEffect(() => {
    api('/platform/costs/summary').then(r => setCosts(r)).catch(() => {});
    api('/platform/health').then(r => setBusStats(r?.intelligence_bus)).catch(() => {});
  }, []);

  return (
    <div style={{ padding: '24px', maxWidth: 1400, margin: '0 auto' }}>

      {/* Page header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{
          fontFamily: 'Syne, sans-serif', fontWeight: 800,
          fontSize: 20, letterSpacing: '6px',
          color: 'var(--t1)', textTransform: 'uppercase', marginBottom: 4,
        }}>
          PLATFORM OVERVIEW
        </div>
        <div style={{ fontFamily: 'Outfit', fontSize: 13, color: 'var(--t3)' }}>
          Real-time status across all three intelligence systems
        </div>
      </div>

      {/* System health cards */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24,
      }}>
        <SystemCard system="oracle"  label="ORACLE"  accent="var(--oc)" health={platformHealth?.systems?.oracle}  theses={oracleTheses} />
        <SystemCard system="compass" label="COMPASS" accent="var(--cc)" health={platformHealth?.systems?.compass} portfolio={compassPortfolio} risk={compassRisk} />
        <SystemCard system="grid"    label="EXECUTE" accent="var(--gc)" health={platformHealth?.systems?.grid} />
      </div>

      {/* Intelligence bus stats */}
      {busStats && (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border-1)',
          borderRadius: 8, padding: 16, marginBottom: 12,
        }}>
          <div style={{
            fontFamily: 'Instrument Sans', fontWeight: 600, fontSize: 11,
            color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 12,
          }}>
            Intelligence Bus
          </div>
          <div style={{ display: 'flex', gap: 32 }}>
            <Stat label="Total Events"    value={busStats.total_events} />
            <Stat label="Events (24h)"    value={busStats.events_24h} />
            <Stat label="Grid Events"     value={busStats.by_system?.grid} />
            <Stat label="Oracle Events"   value={busStats.by_system?.oracle} accent="var(--oc)" />
            <Stat label="Compass Events"  value={busStats.by_system?.compass} accent="var(--cc)" />
          </div>
        </div>
      )}

      {/* AI costs */}
      {costs && (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border-1)',
          borderRadius: 8, padding: 16,
        }}>
          <div style={{
            fontFamily: 'Instrument Sans', fontWeight: 600, fontSize: 11,
            color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 12,
          }}>
            AI Costs — Month to Date
          </div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            <Stat label="Total Spend"   value={`$${parseFloat(costs.month_to_date?.total_usd || 0).toFixed(4)}`} />
            <Stat label="API Calls"     value={costs.month_to_date?.total_calls} />
            <Stat label="Input Tokens"  value={Number(costs.month_to_date?.total_input || 0).toLocaleString()} />
            <Stat label="Output Tokens" value={Number(costs.month_to_date?.total_output || 0).toLocaleString()} />
          </div>
          {costs.by_system?.length > 0 && (
            <div style={{ marginTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {costs.by_system.map(s => (
                <div key={s.source_system} style={{
                  padding: '6px 12px', background: 'var(--elevated)',
                  borderRadius: 4, border: '1px solid var(--border-1)',
                }}>
                  <div style={{ fontFamily: 'IBM Plex Mono', fontSize: 9, color: 'var(--t4)', marginBottom: 2 }}>
                    {s.source_system.toUpperCase()}
                  </div>
                  <div style={{ fontFamily: 'IBM Plex Mono', fontSize: 13, color: 'var(--t1)' }}>
                    ${parseFloat(s.cost_usd).toFixed(4)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SystemCard({ system, label, accent, health, theses, portfolio, risk }) {
  const status = health?.status;
  const isLive = status === 'healthy';
  const noData = !health || status === 'no_data' || status === 'not_deployed';

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border-1)',
      borderRadius: 8, padding: 16,
      borderTop: `2px solid ${isLive ? accent : noData ? 'var(--t5)' : 'var(--warn)'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{
          fontFamily: 'IBM Plex Mono', fontWeight: 600,
          fontSize: 11, letterSpacing: '1.5px', color: accent,
        }}>
          {label}
        </span>
        <div style={{
          marginLeft: 'auto', fontFamily: 'IBM Plex Mono', fontSize: 9,
          color: isLive ? 'var(--profit)' : noData ? 'var(--t4)' : 'var(--warn)',
        }}>
          {noData ? 'NOT DEPLOYED' : status?.toUpperCase()}
        </div>
      </div>

      {health?.last_cycle_at && (
        <div style={{ fontFamily: 'IBM Plex Mono', fontSize: 10, color: 'var(--t3)', marginBottom: 8 }}>
          Last cycle: {new Date(health.last_cycle_at).toLocaleTimeString()}
        </div>
      )}

      {system === 'oracle' && theses?.length > 0 && (
        <div style={{ fontFamily: 'Outfit', fontSize: 12, color: 'var(--t2)' }}>
          {theses.length} active {theses.length === 1 ? 'thesis' : 'theses'}
        </div>
      )}
      {system === 'compass' && portfolio && (
        <div style={{ fontFamily: 'IBM Plex Mono', fontSize: 11, color: 'var(--t1)' }}>
          {portfolio.risk_posture?.toUpperCase()} · {risk ? `Risk ${parseFloat(risk.risk_score).toFixed(1)}/10` : ''}
        </div>
      )}
      {system === 'grid' && health?.cycle_duration_ms && (
        <div style={{ fontFamily: 'IBM Plex Mono', fontSize: 10, color: 'var(--t3)' }}>
          Cycle: {(health.cycle_duration_ms / 1000).toFixed(1)}s
          {health.agents_succeeded != null && ` · ${health.agents_succeeded} agents`}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div style={{ fontFamily: 'IBM Plex Mono', fontSize: 9, color: 'var(--t4)', marginBottom: 4 }}>
        {label.toUpperCase()}
      </div>
      <div style={{
        fontFamily: 'IBM Plex Mono', fontWeight: 300, fontSize: 20,
        color: accent || 'var(--t1)',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value ?? '—'}
      </div>
    </div>
  );
}
