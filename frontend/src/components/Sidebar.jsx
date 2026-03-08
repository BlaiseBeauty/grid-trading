import { NavLink } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { useDataStore } from '../stores/data';
import { StatusPulse } from './ui';

const NAV = [
  { path: '/', label: 'Command Centre', icon: '⬡' },
  { path: '/agents', label: 'Agents', icon: '◈' },
  { path: '/trades', label: 'Trades', icon: '◇' },
  { path: '/strategy', label: 'Strategy Lab', icon: '△' },
  { path: '/learnings', label: 'Learnings', icon: '◆' },
  { path: '/analytics', label: 'Analytics', icon: '◎' },
  { path: '/backtest', label: 'Backtest', icon: '◑' },
  { path: '/settings', label: 'Settings', icon: '⚙' },
];

export default function Sidebar({ open, onClose }) {
  const logout = useAuthStore(s => s.logout);
  const system = useDataStore(s => s.system);

  return (
    <aside className={`v2-sidebar ${open ? 'open' : ''}`}>
      <div className="v2-sidebar-brand">
        <span className="v2-brand-text">GRID</span>
        {system?.bootstrap_phase && (
          <span className={`v2-phase-badge v2-phase-${system.bootstrap_phase}`}>
            {system.bootstrap_phase}
          </span>
        )}
      </div>

      <nav className="v2-sidebar-nav">
        {NAV.map(({ path, label, icon }) => (
          <NavLink
            key={path}
            to={path}
            end={path === '/'}
            className={({ isActive }) => `v2-nav-item ${isActive ? 'active' : ''}`}
            onClick={onClose}
          >
            <span className="v2-nav-icon">{icon}</span>
            <span className="v2-nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="v2-sidebar-footer">
        {system?.scram_level && (
          <div className="v2-scram-indicator">
            <StatusPulse status="error" size={6} />
            <span className="v2-scram-text">SCRAM: {system.scram_level.toUpperCase()}</span>
          </div>
        )}
        <button className="v2-logout-btn" onClick={logout}>Logout</button>
      </div>

      <style>{`
        .v2-sidebar {
          width: var(--sidebar-width);
          height: 100vh;
          background: var(--v2-bg-primary);
          border-right: 1px solid var(--v2-border);
          display: flex;
          flex-direction: column;
          position: fixed;
          left: 0;
          top: 0;
          z-index: 10;
        }
        .v2-sidebar-brand {
          padding: var(--v2-space-xl) var(--v2-space-lg);
          border-bottom: 1px solid var(--v2-border);
          display: flex;
          align-items: center;
          gap: var(--v2-space-sm);
        }
        .v2-brand-text {
          font-family: 'Syne', sans-serif;
          font-weight: 800;
          font-size: 24px;
          letter-spacing: 8px;
          color: var(--v2-accent-cyan);
          text-shadow: 0 0 20px rgba(0,229,255,0.3);
        }
        .v2-phase-badge {
          font-family: var(--v2-font-data);
          font-size: 9px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 2px 6px;
          border-radius: 3px;
          border: 1px solid var(--v2-border);
          color: var(--v2-text-secondary);
        }
        .v2-phase-infant { color: var(--v2-accent-amber); border-color: rgba(255,171,0,0.3); }
        .v2-phase-learning { color: var(--v2-accent-cyan); border-color: rgba(0,229,255,0.3); }
        .v2-phase-maturing { color: var(--v2-accent-green); border-color: rgba(0,230,118,0.3); }
        .v2-phase-graduated { color: var(--v2-accent-green); border-color: rgba(0,230,118,0.3); }
        .v2-sidebar-nav {
          flex: 1;
          padding: var(--v2-space-lg) 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .v2-nav-item {
          display: flex;
          align-items: center;
          gap: var(--v2-space-md);
          padding: var(--v2-space-md) var(--v2-space-lg);
          color: var(--v2-text-secondary);
          font-family: var(--v2-font-body);
          font-weight: 500;
          font-size: 13px;
          text-decoration: none;
          transition: all var(--v2-duration-fast) var(--v2-ease-out);
          border-left: 2px solid transparent;
        }
        .v2-nav-item:hover {
          color: var(--v2-text-primary);
          background: var(--v2-bg-secondary);
        }
        .v2-nav-item.active {
          color: var(--v2-accent-cyan);
          background: rgba(0,229,255,0.05);
          border-left-color: var(--v2-accent-cyan);
        }
        .v2-nav-icon { font-size: 16px; width: 20px; text-align: center; }
        .v2-sidebar-footer {
          padding: var(--v2-space-lg);
          border-top: 1px solid var(--v2-border);
        }
        .v2-scram-indicator {
          display: flex;
          align-items: center;
          gap: var(--v2-space-sm);
          padding: var(--v2-space-sm) var(--v2-space-md);
          margin-bottom: var(--v2-space-sm);
          border-radius: var(--v2-radius-sm);
          background: rgba(255,23,68,0.08);
          border: 1px solid rgba(255,23,68,0.2);
        }
        .v2-scram-text {
          font-family: var(--v2-font-data);
          font-size: 10px;
          font-weight: 600;
          color: var(--v2-accent-red);
          letter-spacing: 1px;
        }
        .v2-logout-btn {
          width: 100%;
          padding: var(--v2-space-sm);
          color: var(--v2-text-secondary);
          font-family: var(--v2-font-data);
          font-size: 11px;
          transition: color var(--v2-duration-fast);
        }
        .v2-logout-btn:hover { color: var(--v2-text-primary); }
      `}</style>
    </aside>
  );
}
