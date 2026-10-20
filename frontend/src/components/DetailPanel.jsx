import { useCallback, useEffect, useRef, useState } from 'react';

// Shared right-hand detail panel / drawer.
//  - >= 680px wide on desktop (house rule), full width on phones (max-width: 100vw)
//  - resizable by dragging (or arrow keys on) the left handle
//  - expandable to full width with the toggle in the header
//  - role="dialog", Escape closes, focus moves in, is trapped, and is restored on close
const MIN_WIDTH = 680;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function clampWidth(w) {
  const max = typeof window === 'undefined' ? 1200 : window.innerWidth;
  return Math.max(Math.min(MIN_WIDTH, max), Math.min(w, max));
}

export default function DetailPanel({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  defaultWidth = MIN_WIDTH,
  zIndex = 1002,
  ariaLabel,
  // modal=false: no backdrop, no focus trap/steal (for live panels the user keeps working beside,
  // e.g. the running-cycle monitor). Escape still closes while focus is inside the panel.
  modal = true,
}) {
  const [width, setWidth] = useState(() => clampWidth(defaultWidth));
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef(null);
  const lastFocusRef = useRef(null);

  // Always call the latest onClose without re-running the focus effect when the parent re-renders
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  // Focus management + Escape + Tab trap
  useEffect(() => {
    if (!open || !modal) return undefined;
    lastFocusRef.current = document.activeElement;
    const panel = panelRef.current;
    if (panel) panel.focus();

    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
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
      const prev = lastFocusRef.current;
      if (prev && typeof prev.focus === 'function') prev.focus();
    };
  }, [open, modal]);

  // Keep width valid when the window shrinks
  useEffect(() => {
    function onResize() { setWidth(w => clampWidth(w)); }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
    setExpanded(false);
  }, []);
  const onPointerMove = useCallback((e) => {
    if (!dragging) return;
    setWidth(clampWidth(window.innerWidth - e.clientX));
  }, [dragging]);
  const onPointerUp = useCallback((e) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(false);
  }, []);
  const onHandleKey = useCallback((e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setExpanded(false); setWidth(w => clampWidth(w + 40)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setExpanded(false); setWidth(w => clampWidth(w - 40)); }
  }, []);

  if (!open) return null;

  return (
    <>
      {modal && <div className="dp-backdrop" style={{ zIndex: zIndex - 1 }} onClick={onClose} aria-hidden="true" />}
      <div
        ref={panelRef}
        className={`dp-panel${dragging ? ' dp-panel--dragging' : ''}`}
        role="dialog"
        aria-modal={modal ? 'true' : undefined}
        aria-label={ariaLabel || (typeof title === 'string' ? title : 'Details')}
        tabIndex={-1}
        onKeyDown={modal ? undefined : (e) => { if (e.key === 'Escape') onClose?.(); }}
        style={{ zIndex, width: expanded ? '100vw' : width }}
      >
        <div
          className="dp-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onHandleKey}
        />
        <div className="dp-header">
          <div className="dp-heading">
            <div className="dp-title">{title}</div>
            {subtitle && <div className="dp-subtitle">{subtitle}</div>}
          </div>
          <div className="dp-actions">
            <button
              type="button"
              className="dp-btn dp-expand"
              onClick={() => setExpanded(x => !x)}
              aria-label={expanded ? 'Restore panel width' : 'Expand panel to full width'}
              aria-pressed={expanded}
            >
              {expanded ? '⤢' : '⤡'}
            </button>
            <button type="button" className="dp-btn" onClick={onClose} aria-label="Close panel">{'✕'}</button>
          </div>
        </div>
        <div className="dp-body">{children}</div>
        {footer && <div className="dp-footer">{footer}</div>}
      </div>

      <style>{`
        .dp-backdrop { position: fixed; inset: 0; background: var(--v2-overlay); }
        .dp-panel {
          position: fixed; top: 0; right: 0; bottom: 0;
          max-width: 100vw;
          background: var(--surface);
          border-left: 1px solid var(--border-2);
          box-shadow: var(--v2-shadow-lg);
          display: flex; flex-direction: column;
          animation: dp-in 220ms var(--v2-ease-out) both;
          outline: none;
        }
        .dp-panel--dragging { user-select: none; }
        @keyframes dp-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
        .dp-handle {
          position: absolute; left: -4px; top: 0; bottom: 0; width: 8px;
          cursor: col-resize; touch-action: none; z-index: 2;
        }
        .dp-handle:hover, .dp-panel--dragging .dp-handle { background: var(--v2-tint-cyan-strong); }
        @media (max-width: 719px) { .dp-handle { display: none; } .dp-expand { display: none; } .dp-panel { width: 100vw !important; } }
        .dp-header {
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          padding: 16px 20px 12px; border-bottom: 1px solid var(--border-1); flex-shrink: 0;
        }
        .dp-heading { min-width: 0; }
        .dp-title {
          font-family: 'Instrument Sans', sans-serif; font-weight: 600; font-size: 13px;
          color: var(--t2); text-transform: uppercase; letter-spacing: 1px;
        }
        .dp-subtitle { font-size: 12px; color: var(--t3); margin-top: 2px; }
        .dp-actions { display: flex; gap: 4px; flex-shrink: 0; }
        .dp-btn {
          min-width: 32px; min-height: 32px; border-radius: var(--radius-sm);
          color: var(--t3); font-size: 16px; line-height: 1;
        }
        .dp-btn:hover { color: var(--t1); background: var(--v2-fill-2); }
        .dp-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
        .dp-footer { padding: 10px 20px; border-top: 1px solid var(--border-1); flex-shrink: 0; }
      `}</style>
    </>
  );
}
