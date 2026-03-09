import { useNavigate } from 'react-router-dom';
import usePlatformStore from '../stores/platform';

const SYSTEMS = [
  {
    id: 'grid',
    shortLabel: 'EXECUTE',
    accent: 'var(--gc)',
    border: 'var(--gc-border)',
    tint: 'var(--gc-tint)',
    route: '/',
  },
  {
    id: 'compass',
    shortLabel: 'COMPASS',
    accent: 'var(--cc)',
    border: 'var(--cc-border)',
    tint: 'var(--cc-tint)',
    route: '/compass',
  },
  {
    id: 'oracle',
    shortLabel: 'ORACLE',
    accent: 'var(--oc)',
    border: 'var(--oc-border)',
    tint: 'var(--oc-tint)',
    route: '/oracle',
  },
  {
    id: 'platform',
    shortLabel: 'PLATFORM',
    accent: 'var(--t2)',
    border: 'var(--border-2)',
    tint: 'transparent',
    route: '/platform',
  },
];

export default function SystemSwitcher() {
  const { activeSystem, setActiveSystem, unreadCount, toggleDrawer, monthlyCostUsd } = usePlatformStore();
  const navigate = useNavigate();

  function handleSystemClick(system) {
    setActiveSystem(system.id);
    navigate(system.route);
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      height: 'var(--shell-switcher-height)',
      background: 'var(--abyss)',
      borderBottom: '1px solid var(--border-1)',
      display: 'flex',
      alignItems: 'stretch',
      zIndex: 1000,
      userSelect: 'none',
    }}>

      {/* Brand wordmark */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        borderRight: '1px solid var(--border-1)',
        minWidth: 120,
      }}>
        <span style={{
          fontFamily: 'Syne, sans-serif',
          fontWeight: 800,
          fontSize: 16,
          letterSpacing: '6px',
          color: 'var(--t1)',
          textTransform: 'uppercase',
        }}>
          GRID
        </span>
      </div>

      {/* System tabs */}
      <div style={{ display: 'flex', flex: 1 }}>
        {SYSTEMS.map(sys => {
          const isActive = activeSystem === sys.id;
          return (
            <button
              key={sys.id}
              onClick={() => handleSystemClick(sys)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 20px',
                background: isActive ? sys.tint : 'transparent',
                border: 'none',
                borderBottom: isActive
                  ? `2px solid ${sys.accent}`
                  : '2px solid transparent',
                cursor: 'pointer',
                transition: 'all 150ms ease',
                position: 'relative',
              }}
            >
              <span style={{
                fontFamily: 'IBM Plex Mono, monospace',
                fontWeight: 600,
                fontSize: 10,
                letterSpacing: '1.5px',
                textTransform: 'uppercase',
                color: isActive ? sys.accent : 'var(--t3)',
                transition: 'color 150ms ease',
              }}>
                {sys.shortLabel}
              </span>
            </button>
          );
        })}
      </div>

      {/* Right side: costs badge + notification bell */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 16px',
        borderLeft: '1px solid var(--border-1)',
      }}>
        {monthlyCostUsd !== null && (
          <div style={{
            fontFamily: 'IBM Plex Mono, monospace',
            fontSize: 9,
            fontWeight: 500,
            color: 'var(--t3)',
            letterSpacing: '0.5px',
          }}>
            ${parseFloat(monthlyCostUsd).toFixed(2)}/mo
          </div>
        )}
        <button
          onClick={toggleDrawer}
          style={{
            position: 'relative',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: unreadCount > 0 ? 'var(--cyan)' : 'var(--t3)',
            transition: 'color 150ms ease',
          }}
        >
          {/* Bell SVG */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 1a5 5 0 0 0-5 5v3l-1 2h12l-1-2V6a5 5 0 0 0-5-5z"
              stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M6.5 13a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.5"/>
          </svg>

          {/* Unread count badge */}
          {unreadCount > 0 && (
            <span style={{
              position: 'absolute',
              top: 2,
              right: 2,
              background: 'var(--loss)',
              color: 'white',
              fontFamily: 'IBM Plex Mono, monospace',
              fontSize: 7,
              fontWeight: 700,
              lineHeight: 1,
              padding: '1px 3px',
              borderRadius: 4,
              minWidth: 12,
              textAlign: 'center',
            }}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
