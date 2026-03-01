import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/auth';
import { useWebSocket } from './hooks/useWebSocket';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import Trades from './pages/Trades';
import StrategyLab from './pages/StrategyLab';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';

function Layout({ children }) {
  useWebSocket();
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
        padding: 'var(--space-xl)',
        background: 'var(--abyss)',
        minHeight: '100vh',
        overflow: 'auto',
      }}>
        {children}
      </main>
    </div>
  );
}

export default function App() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);

  if (!isAuthenticated) return <Login />;

  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
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
