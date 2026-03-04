import { useState } from 'react';
import { useAuthStore } from '../stores/auth';
import { StatusPulse } from '../components/ui';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, error, loading } = useAuthStore();

  const handleSubmit = (e) => {
    e.preventDefault();
    login(email, password);
  };

  return (
    <div className="v2-login-page">
      <div className="v2-login-card">
        <h1 className="v2-login-brand">GRID</h1>
        <p className="v2-login-subtitle">Autonomous Trading Intelligence</p>

        <form onSubmit={handleSubmit} className="v2-login-form">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="v2-login-input"
            required
            autoFocus
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="v2-login-input"
            required
          />
          {error && <div className="v2-login-error">{error}</div>}
          <button type="submit" disabled={loading} className="v2-login-btn">
            {loading ? (
              <span className="v2-login-loading">
                <StatusPulse status="active" size={6} />
                <span>Authenticating</span>
              </span>
            ) : 'Enter'}
          </button>
        </form>
      </div>

      <style>{`
        .v2-login-page {
          height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--v2-bg-primary);
          background-image: radial-gradient(ellipse at 50% 0%, rgba(0,229,255,0.04) 0%, transparent 60%);
        }
        .v2-login-card {
          background: var(--v2-glass-bg);
          backdrop-filter: var(--v2-glass-blur);
          border: 1px solid var(--v2-border);
          border-radius: var(--v2-radius-lg);
          padding: var(--v2-space-3xl);
          width: 380px;
          text-align: center;
          box-shadow: var(--v2-glow-cyan);
          animation: v2-fade-in-up var(--v2-duration-slow) var(--v2-ease-out);
        }
        .v2-login-brand {
          font-family: 'Syne', sans-serif;
          font-weight: 800;
          font-size: 36px;
          letter-spacing: 10px;
          color: var(--v2-accent-cyan);
          margin-bottom: var(--v2-space-xs);
          text-shadow: 0 0 24px rgba(79,195,247,0.25);
        }
        .v2-login-subtitle {
          font-family: var(--v2-font-body);
          font-size: 12px;
          color: var(--v2-text-muted);
          text-transform: uppercase;
          letter-spacing: 3px;
          margin-bottom: var(--v2-space-2xl);
        }
        .v2-login-form {
          display: flex;
          flex-direction: column;
          gap: var(--v2-space-md);
        }
        .v2-login-input {
          width: 100%;
          padding: var(--v2-space-md);
          background: var(--v2-bg-secondary);
          border: 1px solid var(--v2-border);
          border-radius: var(--v2-radius-sm);
          color: var(--v2-text-primary);
          font-family: var(--v2-font-data);
          font-size: 13px;
          transition: border-color var(--v2-duration-fast);
          outline: none;
        }
        .v2-login-input:focus {
          border-color: var(--v2-accent-cyan);
          box-shadow: 0 0 0 1px rgba(79,195,247,0.15);
        }
        .v2-login-input::placeholder {
          color: var(--v2-text-muted);
        }
        .v2-login-btn {
          width: 100%;
          padding: var(--v2-space-md);
          background: var(--v2-accent-cyan);
          color: var(--v2-bg-primary);
          font-family: var(--v2-font-data);
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 2px;
          border-radius: var(--v2-radius-sm);
          transition: all var(--v2-duration-fast);
          cursor: pointer;
        }
        .v2-login-btn:hover {
          box-shadow: 0 0 24px rgba(79,195,247,0.2);
        }
        .v2-login-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: var(--v2-space-sm);
        }
        .v2-login-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          box-shadow: none;
        }
        .v2-login-error {
          color: var(--v2-accent-red);
          font-family: var(--v2-font-data);
          font-size: 12px;
          padding: var(--v2-space-sm);
          background: rgba(255,23,68,0.08);
          border: 1px solid rgba(255,23,68,0.2);
          border-radius: var(--v2-radius-sm);
        }
      `}</style>
    </div>
  );
}
