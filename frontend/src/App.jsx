import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './stores/auth';
import { useWebSocket } from './hooks/useWebSocket';
import useIsMobile from './hooks/useIsMobile';
import usePlatformStore from './stores/platform';
import PlatformShell from './shell/PlatformShell';
import Sidebar from './components/Sidebar';
import CycleControl from './components/CycleControl';
import ErrorBoundary from './components/ErrorBoundary';
import UpdateToast from './components/UpdateToast';
import { LoadingState } from './components/StateBlock';
import Login from './pages/Login';

// Route-level code splitting: Login and the shell stay eager, every page is its own chunk.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const MobileDashboard = lazy(() => import('./pages/MobileDashboard'));
const Agents = lazy(() => import('./pages/Agents'));
const Trades = lazy(() => import('./pages/Trades'));
const StrategyLab = lazy(() => import('./pages/StrategyLab'));
const Learnings = lazy(() => import('./pages/Learnings'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Settings = lazy(() => import('./pages/Settings'));
const Backtest = lazy(() => import('./pages/Backtest'));
const Observation = lazy(() => import('./pages/Observation'));
const CompassDashboard = lazy(() => import('./systems/compass/CompassDashboard'));
const OracleDashboard = lazy(() => import('./systems/oracle/OracleDashboard'));
const PlatformOverview = lazy(() => import('./systems/platform/PlatformOverview'));

// GRID pages get the sidebar; COMPASS/ORACLE/PLATFORM pages don't
const GRID_ROUTES = ['/', '/agents', '/trades', '/strategy', '/learnings', '/analytics', '/backtest', '/observation', '/settings'];

function routeToSystem(pathname) {
  if (pathname.startsWith('/compass')) return 'compass';
  if (pathname.startsWith('/oracle')) return 'oracle';
  if (pathname.startsWith('/platform')) return 'platform';
  return 'grid';
}

// One error boundary + suspense per routed page: a crash in one page never takes down the shell.
function Page({ label, children }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary label={label} resetKey={pathname}>
      <Suspense fallback={<LoadingState>Loading {label}…</LoadingState>}>
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}

function Layout({ children }) {
  useWebSocket();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useIsMobile();

  const isGridPage = GRID_ROUTES.includes(location.pathname);

  // Keep activeSystem in sync with the route (effect, never during render)
  const setActiveSystem = usePlatformStore(s => s.setActiveSystem);
  const routeSystem = routeToSystem(location.pathname);
  useEffect(() => {
    setActiveSystem(routeSystem);
  }, [routeSystem, setActiveSystem]);

  // Close the off-canvas sidebar whenever the route changes
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

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
        {/* Compact header with the sidebar toggle: shown by CSS below 1024px (tablet widths 768-1023),
            hidden on wide desktops where the sidebar is permanent. Phones use the separate mobile tree above. */}
        {isGridPage && (
          <div className="mobile-header">
            <button
              type="button"
              className="hamburger"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={sidebarOpen}
            >
              {'☰'}
            </button>
            <span className="mobile-brand">GRID</span>
          </div>
        )}

        {/* Sidebar overlay (below 1024px) */}
        <div
          className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`}
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />

        {/* Sidebar only shows for GRID pages */}
        {isGridPage && (
          <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        )}

        <main className={isGridPage ? 'app-main--grid' : undefined} style={{
          marginLeft: isGridPage ? 'var(--sidebar-width)' : 0,
          flex: 1,
          padding: isGridPage ? 'var(--v2-space-xl)' : 0,
          background: 'var(--v2-bg-primary)',
          minHeight: '100vh',
          overflow: 'auto',
          minWidth: 0,
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

function AppRoutes({ isMobile }) {
  return (
    <Routes>
      {/* GRID pages */}
      <Route path="/" element={isMobile
        ? <Page label="Dashboard"><MobileDashboard /></Page>
        : <Page label="Dashboard"><Dashboard /></Page>} />
      <Route path="/agents" element={<Page label="Agents"><Agents /></Page>} />
      <Route path="/trades" element={<Page label="Trades"><Trades /></Page>} />
      <Route path="/strategy" element={<Page label="Strategy Lab"><StrategyLab /></Page>} />
      <Route path="/learnings" element={<Page label="Learnings"><Learnings /></Page>} />
      <Route path="/analytics" element={<Page label="Analytics"><Analytics /></Page>} />
      <Route path="/backtest" element={<Page label="Backtest"><Backtest /></Page>} />
      <Route path="/observation" element={<Page label="Observation"><Observation /></Page>} />
      <Route path="/settings" element={<Page label="Settings"><Settings /></Page>} />

      {/* COMPASS, ORACLE, PLATFORM pages */}
      <Route path="/compass" element={<Page label="COMPASS"><CompassDashboard /></Page>} />
      <Route path="/oracle" element={<Page label="ORACLE"><OracleDashboard /></Page>} />
      <Route path="/platform" element={<Page label="Platform"><PlatformOverview /></Page>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  const initialising = useAuthStore(s => s.initialising);
  const init = useAuthStore(s => s.init);
  const isMobile = useIsMobile();

  // Restore the session from the HttpOnly refresh cookie before deciding what to render
  useEffect(() => {
    init();
  }, [init]);

  let body;
  if (initialising) {
    // Neutral splash: no Login flash while the silent refresh is in flight
    body = <div className="app-splash" role="status" aria-label="Loading GRID">GRID</div>;
  } else if (!isAuthenticated) {
    body = <Login />;
  } else {
    body = (
      <BrowserRouter>
        <Layout>
          <AppRoutes isMobile={isMobile} />
        </Layout>
      </BrowserRouter>
    );
  }

  return (
    <>
      {body}
      <UpdateToast />
    </>
  );
}
