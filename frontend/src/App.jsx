import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './stores/auth';
import { useWebSocket } from './hooks/useWebSocket';
import useIsMobile from './hooks/useIsMobile';
import usePlatformStore from './stores/platform';
import PlatformShell from './shell/PlatformShell';
import Sidebar from './components/Sidebar';
import CycleControl from './components/CycleControl';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import MobileDashboard from './pages/MobileDashboard';
import Agents from './pages/Agents';
import Trades from './pages/Trades';
import StrategyLab from './pages/StrategyLab';
import Learnings from './pages/Learnings';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';
import Backtest from './pages/Backtest';
import CompassDashboard from './systems/compass/CompassDashboard';
import OracleDashboard from './systems/oracle/OracleDashboard';
import PlatformOverview from './systems/platform/PlatformOverview';

// GRID pages get the sidebar; COMPASS/ORACLE/PLATFORM pages don't
const GRID_ROUTES = ['/', '/agents', '/trades', '/strategy', '/learnings', '/analytics', '/backtest', '/settings'];

function Layout({ children }) {
  useWebSocket();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useIsMobile();

  const isGridPage = GRID_ROUTES.includes(location.pathname);

  // Sync activeSystem from route
  const setActiveSystem = usePlatformStore(s => s.setActiveSystem);
  const activeSystem = usePlatformStore(s => s.activeSystem);
  const routeSystem = location.pathname.startsWith('/compass') ? 'compass'
    : location.pathname.startsWith('/oracle') ? 'oracle'
    : location.pathname.startsWith('/platform') ? 'platform'
    : 'grid';
  if (routeSystem !== activeSystem) {
    setActiveSystem(routeSystem);
  }

  if (isMobile) {
    return (
      <PlatformShell>
        <div style={{ minHeight: '100vh', background: 'var(--v2-bg-primary)', paddingTop: 'var(--shell-total-top)' }}>
          {children}
          <CycleControl />
        </div>
      </PlatformShell>
    );
  }

  return (
    <PlatformShell>
      <div style={{ display: 'flex', minHeight: '100vh', paddingTop: 'var(--shell-total-top)' }}>
        {/* Mobile header */}
        <div className="mobile-header">
          <button className="hamburger" onClick={() => setSidebarOpen(true)}>☰</button>
          <span className="mobile-brand">GRID</span>
        </div>

        {/* Sidebar overlay for mobile */}
        <div
          className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`}
          onClick={() => setSidebarOpen(false)}
        />

        {/* Sidebar only shows for GRID pages */}
        {isGridPage && (
          <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        )}

        <main style={{
          marginLeft: isGridPage ? 'var(--sidebar-width)' : 0,
          flex: 1,
          padding: isGridPage ? 'var(--v2-space-xl)' : 0,
          background: 'var(--v2-bg-primary)',
          minHeight: '100vh',
          overflow: 'auto',
        }}>
          <div key={location.pathname} className="v2-page-transition">
            {children}
          </div>
        </main>

        {isGridPage && <CycleControl />}
      </div>
    </PlatformShell>
  );
}

export default function App() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  const isMobile = useIsMobile();

  if (!isAuthenticated) return <Login />;

  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          {/* GRID pages */}
          <Route path="/" element={isMobile ? <MobileDashboard /> : <Dashboard />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/trades" element={<Trades />} />
          <Route path="/strategy" element={<StrategyLab />} />
          <Route path="/learnings" element={<Learnings />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="/settings" element={<Settings />} />

          {/* COMPASS, ORACLE, PLATFORM pages */}
          <Route path="/compass" element={<CompassDashboard />} />
          <Route path="/oracle" element={<OracleDashboard />} />
          <Route path="/platform" element={<PlatformOverview />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
