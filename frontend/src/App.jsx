import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './stores/auth';
import { useWebSocket } from './hooks/useWebSocket';
import useIsMobile from './hooks/useIsMobile';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import MobileDashboard from './pages/MobileDashboard';
import Agents from './pages/Agents';
import Trades from './pages/Trades';
import StrategyLab from './pages/StrategyLab';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';

function Layout({ children }) {
  useWebSocket();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--v2-bg-primary)' }}>
        {children}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
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

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <main style={{
        marginLeft: 'var(--sidebar-width)',
        flex: 1,
        padding: 'var(--v2-space-xl)',
        background: 'var(--v2-bg-primary)',
        minHeight: '100vh',
        overflow: 'auto',
      }}>
        <div key={location.pathname} className="v2-page-transition">
          {children}
        </div>
      </main>
    </div>
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
          <Route path="/" element={isMobile ? <MobileDashboard /> : <Dashboard />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/trades" element={<Trades />} />
          <Route path="/strategy" element={<StrategyLab />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
