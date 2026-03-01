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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>

      <style>{`
        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 100;
          backdrop-filter: blur(4px);
        }
        .modal-content {
          background: var(--void);
          border: 1px solid var(--border-2);
          border-radius: var(--radius-lg);
          max-width: 640px;
          width: 90%;
          max-height: 85vh;
          overflow-y: auto;
          box-shadow: 0 24px 64px rgba(0,0,0,0.5);
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--space-lg) var(--space-xl);
          border-bottom: 1px solid var(--border-0);
        }
        .modal-title {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--t1);
        }
        .modal-close {
          font-size: 20px;
          color: var(--t3);
          padding: 4px 8px;
          transition: color var(--transition-fast);
        }
        .modal-close:hover { color: var(--t1); }
        .modal-body {
          padding: var(--space-xl);
        }
      `}</style>
    </div>
  );
}
