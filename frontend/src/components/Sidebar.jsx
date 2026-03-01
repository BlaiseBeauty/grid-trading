import { NavLink } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { useDataStore } from '../stores/data';

const NAV = [
  { path: '/', label: 'Command Centre', icon: '⬡' },
  { path: '/agents', label: 'Agents', icon: '◈' },
  { path: '/trades', label: 'Trades', icon: '◇' },
  { path: '/strategy', label: 'Strategy Lab', icon: '△' },
  { path: '/analytics', label: 'Analytics', icon: '◎' },
  { path: '/settings', label: 'Settings', icon: '⚙' },
];

export default function Sidebar({ open, onClose }) {
  const logout = useAuthStore(s => s.logout);
  const system = useDataStore(s => s.system);

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="sidebar-brand">
        <span className="brand-text">GRID</span>
        {system?.bootstrap_phase && (
          <span className={`badge badge-${system.bootstrap_phase}`}>
            {system.bootstrap_phase}
          </span>
        )}
      </div>

      <nav className="sidebar-nav">
        {NAV.map(({ path, label, icon }) => (
          <NavLink
            key={path}
            to={path}
            end={path === '/'}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            onClick={onClose}
          >
            <span className="nav-icon">{icon}</span>
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        {system?.scram_level && (
          <div className={`scram-indicator badge-${system.scram_level}`}>
            SCRAM: {system.scram_level.toUpperCase()}
          </div>
        )}
        <button className="logout-btn" onClick={logout}>Logout</button>
      </div>

      <style>{`
        .sidebar {
          width: var(--sidebar-width);
          height: 100vh;
          background: var(--abyss);
          border-right: 1px solid var(--border-1);
          display: flex;
          flex-direction: column;
          position: fixed;
          left: 0;
          top: 0;
          z-index: 10;
        }
        .sidebar-brand {
          padding: var(--space-xl) var(--space-lg);
          border-bottom: 1px solid var(--border-0);
          display: flex;
          align-items: center;
          gap: var(--space-sm);
        }
        .brand-text {
          font-family: 'Syne', sans-serif;
          font-weight: 800;
          font-size: 24px;
          letter-spacing: 8px;
          color: var(--cyan);
        }
        .sidebar-nav {
          flex: 1;
          padding: var(--space-lg) 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .nav-item {
          display: flex;
          align-items: center;
          gap: var(--space-md);
          padding: var(--space-md) var(--space-lg);
          color: var(--t3);
          font-family: 'Instrument Sans', sans-serif;
          font-weight: 500;
          font-size: 13px;
          text-decoration: none;
          transition: all var(--transition-fast);
          border-left: 2px solid transparent;
        }
        .nav-item:hover { color: var(--t1); background: var(--surface); }
        .nav-item.active {
          color: var(--cyan);
          background: rgba(0,229,255,0.05);
          border-left-color: var(--cyan);
        }
        .nav-icon { font-size: 16px; width: 20px; text-align: center; }
        .sidebar-footer {
          padding: var(--space-lg);
          border-top: 1px solid var(--border-0);
        }
        .scram-indicator {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          padding: var(--space-sm);
          margin-bottom: var(--space-sm);
          border-radius: var(--radius-sm);
          text-align: center;
        }
        .logout-btn {
          width: 100%;
          padding: var(--space-sm);
          color: var(--t3);
          font-size: 12px;
          transition: color var(--transition-fast);
        }
        .logout-btn:hover { color: var(--t1); }
      `}</style>
    </aside>
  );
}
