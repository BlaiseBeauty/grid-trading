import { useCallback, useEffect } from 'react';
import usePlatformStore from '../stores/platform';
import DetailPanel from '../components/DetailPanel';
import { fmtSignedMoney } from '../lib/format';

const EVENT_LABELS = {
  thesis_created:             { label: 'New Thesis',          system: 'oracle', accent: 'var(--oc)' },
  thesis_conviction_updated:  { label: 'Conviction Updated',  system: 'oracle', accent: 'var(--oc)' },
  thesis_retired:             { label: 'Thesis Retired',      system: 'oracle', accent: 'var(--t3)' },
  macro_regime_update:        { label: 'Regime Update',       system: 'oracle', accent: 'var(--oc)' },
  opportunity_map_update:     { label: 'Opportunity Map',     system: 'oracle', accent: 'var(--oc)' },
  trade_executed:             { label: 'Trade Opened',        system: 'grid',   accent: 'var(--gc)' },
  trade_closed:               { label: 'Trade Closed',        system: 'grid',   accent: 'var(--gc)' },
  scram_triggered:            { label: 'SCRAM',               system: 'grid',   accent: 'var(--loss)' },
  performance_digest:         { label: 'Weekly Digest',       system: 'grid',   accent: 'var(--gc)' },
  allocation_guidance:        { label: 'Allocation Updated',  system: 'compass',accent: 'var(--cc)' },
  portfolio_risk_state:       { label: 'Risk State Updated',  system: 'compass',accent: 'var(--cc)' },
};

export default function NotificationDrawer() {
  const drawerOpen = usePlatformStore(s => s.drawerOpen);
  const setDrawerOpen = usePlatformStore(s => s.setDrawerOpen);
  const clearUnread = usePlatformStore(s => s.clearUnread);
  const busEvents = usePlatformStore(s => s.busEvents);
  const unreadCount = usePlatformStore(s => s.unreadCount);

  // Clear unread when drawer opens
  useEffect(() => {
    if (drawerOpen) clearUnread();
  }, [drawerOpen, clearUnread]);

  const close = useCallback(() => setDrawerOpen(false), [setDrawerOpen]);

  return (
    <>
      {/* Screen-reader announcement of new events (visually hidden, polite) */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {unreadCount > 0 ? `${unreadCount} new platform event${unreadCount === 1 ? '' : 's'}` : ''}
      </div>

      <DetailPanel
        open={drawerOpen}
        onClose={close}
        title="Platform Events"
        subtitle={`${busEvents.length} events`}
        ariaLabel="Platform events"
        zIndex={1002}
        footer={<SystemHealthFooter />}
      >
        <div style={{ margin: '-16px -20px' }}>
          {busEvents.length === 0 ? (
            <div style={{
              padding: '32px 16px', textAlign: 'center',
              fontFamily: 'Outfit, sans-serif', fontSize: 13,
              color: 'var(--t3)',
            }}>
              No events yet.<br/>
              <span style={{ fontSize: 11, color: 'var(--t3)' }}>
                Events appear here when agents complete cycles.
              </span>
            </div>
          ) : (
            busEvents.map((event, idx) => (
              <BusEventItem key={`${event.id}-${idx}`} event={event} />
            ))
          )}
        </div>
      </DetailPanel>
    </>
  );
}

function BusEventItem({ event }) {
  const meta = EVENT_LABELS[event.event_type] || {
    label: event.event_type, system: event.source_system, accent: 'var(--t3)',
  };

  const timeAgo = formatTimeAgo(event.created_at);
  const summary = event.payload_summary;

  return (
    <div style={{
      padding: '10px 16px',
      borderBottom: '1px solid var(--border-0)',
      display: 'flex',
      gap: 10,
      transition: 'background 150ms ease',
    }}
    onMouseEnter={e => e.currentTarget.style.background = 'var(--elevated)'}
    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      {/* Left accent line */}
      <div style={{
        width: 2, flexShrink: 0, borderRadius: 2,
        background: meta.accent,
        alignSelf: 'stretch',
        minHeight: 36,
      }} />

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <span style={{
            fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600,
            fontSize: 9, letterSpacing: '1px',
            color: meta.accent, textTransform: 'uppercase',
          }}>
            {meta.label}
          </span>
          {event.conviction != null && event.conviction !== '' && !isNaN(parseFloat(event.conviction)) && (
            <span style={{
              fontFamily: 'IBM Plex Mono, monospace', fontSize: 9,
              color: 'var(--t4)',
            }}>
              {parseFloat(event.conviction).toFixed(1)}/10
            </span>
          )}
          <span style={{
            fontFamily: 'IBM Plex Mono, monospace', fontSize: 9,
            color: 'var(--t4)', marginLeft: 'auto', flexShrink: 0,
          }}>
            {timeAgo}
          </span>
        </div>

        {/* Summary */}
        <EventSummary eventType={event.event_type} summary={summary}
          assets={event.affected_assets} />
      </div>
    </div>
  );
}

function EventSummary({ eventType, summary, assets }) {
  if (!summary && !assets?.length) return null;

  if (eventType === 'trade_closed' && summary) {
    const pnl = parseFloat(summary.pnl_usd);
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{
          fontFamily: 'Outfit, sans-serif', fontSize: 12, color: 'var(--t2)',
        }}>
          {summary.symbol}
        </span>
        {!isNaN(pnl) && (
          <span style={{
            fontFamily: 'IBM Plex Mono, monospace', fontSize: 11,
            color: pnl >= 0 ? 'var(--profit)' : 'var(--loss)',
          }}>
            {fmtSignedMoney(pnl)}
          </span>
        )}
      </div>
    );
  }

  if ((eventType === 'thesis_created' || eventType === 'thesis_conviction_updated') && summary) {
    return (
      <span style={{
        fontFamily: 'Outfit, sans-serif', fontSize: 12, color: 'var(--t2)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        display: 'block',
      }}>
        {summary.thesis_name || 'New thesis'}
      </span>
    );
  }

  if (eventType === 'scram_triggered' && summary) {
    return (
      <span style={{
        fontFamily: 'Outfit, sans-serif', fontSize: 12,
        color: 'var(--loss)',
      }}>
        {summary.level?.toUpperCase()} — {summary.reason}
      </span>
    );
  }

  if (eventType === 'performance_digest' && summary) {
    return (
      <div style={{ display: 'flex', gap: 12 }}>
        <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 10, color: 'var(--t3)' }}>
          WIN {summary.win_rate}%
        </span>
        <span style={{
          fontFamily: 'IBM Plex Mono, monospace', fontSize: 10,
          color: parseFloat(summary.total_pnl_usd) >= 0 ? 'var(--profit)' : 'var(--loss)',
        }}>
          P&L {fmtSignedMoney(parseFloat(summary.total_pnl_usd || 0))}
        </span>
      </div>
    );
  }

  // Generic fallback: show affected assets
  if (assets?.length) {
    return (
      <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 10, color: 'var(--t3)' }}>
        {assets.slice(0, 4).join(' · ')}
      </span>
    );
  }

  return null;
}

function SystemHealthFooter() {
  const { platformHealth } = usePlatformStore();

  const systems = [
    { id: 'grid',    label: 'EXE', accent: 'var(--gc)' },
    { id: 'compass', label: 'NAV', accent: 'var(--cc)' },
    { id: 'oracle',  label: 'INT', accent: 'var(--oc)' },
  ];

  return (
    <div style={{
      padding: '10px 16px',
      borderTop: '1px solid var(--border-1)',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      flexShrink: 0,
    }}>
      {systems.map(sys => {
        const health = platformHealth?.systems?.[sys.id];
        const isLive = health?.status === 'healthy';
        const noData = !health || health.status === 'no_data' || health.status === 'not_deployed';
        return (
          <div key={sys.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{
              width: 5, height: 5, borderRadius: '50%',
              background: noData ? 'var(--t5)'
                        : isLive ? 'var(--profit)'
                        : 'var(--warn)',
            }} />
            <span style={{
              fontFamily: 'IBM Plex Mono, monospace',
              fontSize: 9, fontWeight: 600,
              color: noData ? 'var(--t4)' : isLive ? sys.accent : 'var(--warn)',
              letterSpacing: '1px',
            }}>
              {sys.label}
            </span>
          </div>
        );
      })}
      <span style={{
        fontFamily: 'IBM Plex Mono, monospace', fontSize: 8,
        color: 'var(--t5)', marginLeft: 'auto',
      }}>
        PLATFORM HEALTH
      </span>
    </div>
  );
}

function formatTimeAgo(isoString) {
  if (!isoString) return '';
  const mins = Math.round((Date.now() - new Date(isoString)) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
