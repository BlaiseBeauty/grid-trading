import { useEffect } from 'react';

export default function Modal({ open, onClose, title, children }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="v2-modal-overlay" onClick={onClose}>
      <div className="v2-modal-content v2-animate-in" onClick={e => e.stopPropagation()}>
        <div className="v2-modal-header">
          <span className="v2-modal-title">{title}</span>
          <button className="v2-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="v2-modal-body">{children}</div>
      </div>

      <style>{`
        .v2-modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.75);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 100;
          backdrop-filter: blur(8px);
        }
        .v2-modal-content {
          background: var(--v2-bg-primary);
          border: 1px solid var(--v2-border-hover);
          border-radius: var(--v2-radius-lg);
          max-width: 680px;
          width: 92%;
          max-height: 85vh;
          overflow-y: auto;
          box-shadow: 0 24px 80px rgba(0,0,0,0.6), var(--v2-glow-cyan);
        }
        .v2-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--v2-space-lg) var(--v2-space-xl);
          border-bottom: 1px solid var(--v2-border);
        }
        .v2-modal-title {
          font-family: var(--v2-font-data);
          font-size: 13px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--v2-accent-cyan);
        }
        .v2-modal-close {
          font-size: 22px;
          color: var(--v2-text-secondary);
          padding: 4px 8px;
          transition: color var(--v2-duration-fast);
          line-height: 1;
        }
        .v2-modal-close:hover { color: var(--v2-text-primary); }
        .v2-modal-body {
          padding: var(--v2-space-xl);
        }
      `}</style>
    </div>
  );
}
