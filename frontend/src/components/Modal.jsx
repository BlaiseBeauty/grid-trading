import { useEffect, useId, useRef } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Centered modal dialog. For side detail views use DetailPanel instead (wider, resizable).
// role="dialog" + aria-modal, Escape closes, focus moves in and is trapped, then restored on close.
export default function Modal({ open, onClose, title, children }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  // Latest onClose without re-running the focus effect on every parent render
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();

    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="v2-modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="v2-modal-content v2-animate-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="v2-modal-header">
          <span id={titleId} className="v2-modal-title">{title}</span>
          <button type="button" className="v2-modal-close" onClick={onClose} aria-label="Close dialog">&times;</button>
        </div>
        <div className="v2-modal-body">{children}</div>
      </div>

      <style>{`
        .v2-modal-overlay {
          position: fixed;
          inset: 0;
          background: var(--v2-overlay);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1100; /* above the platform shell (1000-1002) */
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
          box-shadow: var(--v2-shadow-lg), var(--v2-glow-cyan);
          outline: none;
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
