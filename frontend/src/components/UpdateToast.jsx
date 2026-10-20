import { applyUpdate, dismissUpdate, useUpdateAvailable } from '../lib/pwa';

// "New version - Reload" toast. aria-live so screen readers hear it; never reloads on its own.
export default function UpdateToast() {
  const available = useUpdateAvailable();
  if (!available) return null;
  return (
    <div className="update-toast" role="status" aria-live="polite">
      <span>New version available</span>
      <button type="button" className="update-toast__btn" onClick={applyUpdate}>Reload</button>
      <button type="button" className="update-toast__dismiss" onClick={dismissUpdate} aria-label="Dismiss update notice">
        {'✕'}
      </button>
      <style>{`
        .update-toast {
          position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
          z-index: 10000; display: flex; align-items: center; gap: 12px;
          max-width: calc(100vw - 32px);
          padding: 10px 14px; border-radius: var(--v2-radius-md);
          background: var(--v2-bg-elevated); color: var(--v2-text-primary);
          border: 1px solid var(--v2-border-hover); box-shadow: var(--v2-shadow-lg);
          font-size: 13px;
        }
        .update-toast__btn {
          padding: 4px 12px; border-radius: var(--v2-radius-sm);
          background: var(--v2-accent-cyan); color: var(--v2-on-accent); font-weight: 600; font-size: 12px;
        }
        .update-toast__dismiss { color: var(--v2-text-muted); padding: 4px 6px; }
        .update-toast__dismiss:hover { color: var(--v2-text-primary); }
      `}</style>
    </div>
  );
}
