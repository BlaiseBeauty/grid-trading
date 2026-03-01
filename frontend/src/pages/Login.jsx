import { useState } from 'react';
import { useAuthStore } from '../stores/auth';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, error, loading } = useAuthStore();

  const handleSubmit = (e) => {
    e.preventDefault();
    login(email, password);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-brand">GRID</h1>
        <p className="login-subtitle">Autonomous Trading Intelligence</p>

        <form onSubmit={handleSubmit} className="login-form">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={loading} className="login-btn">
            {loading ? 'Authenticating...' : 'Enter'}
          </button>
        </form>
      </div>

      <style>{`
        .login-page {
          height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--void);
        }
        .login-card {
          background: var(--surface);
          border: 1px solid var(--border-1);
          border-radius: var(--radius-lg);
          padding: var(--space-3xl);
          width: 360px;
          text-align: center;
        }
        .login-brand {
          font-family: 'Syne', sans-serif;
          font-weight: 800;
          font-size: 32px;
          letter-spacing: 8px;
          color: var(--cyan);
          margin-bottom: var(--space-xs);
        }
        .login-subtitle {
          font-family: 'Instrument Sans', sans-serif;
          font-size: 12px;
          color: var(--t3);
          text-transform: uppercase;
          letter-spacing: 2px;
          margin-bottom: var(--space-2xl);
        }
        .login-form {
          display: flex;
          flex-direction: column;
          gap: var(--space-md);
        }
        .login-form input {
          width: 100%;
          padding: var(--space-md);
        }
        .login-btn {
          width: 100%;
          padding: var(--space-md);
          background: var(--cyan);
          color: var(--void);
          font-family: 'IBM Plex Mono', monospace;
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 1px;
          border-radius: var(--radius-sm);
          transition: opacity var(--transition-fast);
        }
        .login-btn:hover { opacity: 0.9; }
        .login-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .login-error {
          color: var(--loss);
          font-size: 12px;
          padding: var(--space-sm);
          background: rgba(255,45,85,0.10);
          border-radius: var(--radius-sm);
        }
      `}</style>
    </div>
  );
}
