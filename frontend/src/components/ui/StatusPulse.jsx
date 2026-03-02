/**
 * StatusPulse — Pulsing dot indicator with optional label.
 *
 * Props:
 *   status  ('active' | 'warning' | 'error' | 'idle')
 *   size    (number, default 8) — dot diameter in px
 *   label   (string, optional) — text label beside the dot
 */

const STATUS_COLORS = {
  active: 'var(--v2-accent-green)',
  warning: 'var(--v2-accent-amber)',
  error: 'var(--v2-accent-red)',
  idle: 'var(--v2-text-muted)',
};

export default function StatusPulse({ status = 'idle', size = 8, label }) {
  const color = STATUS_COLORS[status] || STATUS_COLORS.idle;
  const shouldPulse = status === 'active' || status === 'warning' || status === 'error';

  return (
    <span className="v2-status-pulse">
      <span
        className={`v2-status-dot ${shouldPulse ? 'v2-status-dot--pulsing' : ''}`}
        style={{
          width: size,
          height: size,
          backgroundColor: color,
          boxShadow: shouldPulse ? `0 0 ${size}px ${color}` : 'none',
        }}
      />
      {label && <span className="v2-status-label">{label}</span>}
      <style>{`
        .v2-status-pulse {
          display: inline-flex;
          align-items: center;
          gap: var(--v2-space-sm);
        }
        .v2-status-dot {
          border-radius: 50%;
          flex-shrink: 0;
        }
        .v2-status-dot--pulsing {
          animation: v2-status-pulse 2s ease-in-out infinite;
        }
        .v2-status-label {
          font-family: var(--v2-font-data);
          font-size: 11px;
          font-weight: 500;
          color: var(--v2-text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
      `}</style>
    </span>
  );
}
