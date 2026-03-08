/**
 * SignalBadge — Colored pill badge for directional signals.
 *
 * Props:
 *   direction  ('long' | 'short' | 'hold' | 'bullish' | 'bearish' | 'neutral')
 *   size       ('sm' | 'md', default 'sm')
 */

const BADGE_CONFIG = {
  long:    { label: 'LONG',    arrow: '\u25B2', color: 'var(--v2-accent-green)', bg: 'rgba(102,187,106,0.12)' },
  bullish: { label: 'BULLISH', arrow: '\u25B2', color: 'var(--v2-accent-green)', bg: 'rgba(102,187,106,0.12)' },
  short:   { label: 'SHORT',   arrow: '\u25BC', color: 'var(--v2-accent-red)',   bg: 'rgba(239,83,80,0.12)' },
  bearish: { label: 'BEARISH', arrow: '\u25BC', color: 'var(--v2-accent-red)',   bg: 'rgba(239,83,80,0.12)' },
  hold:    { label: 'HOLD',    arrow: '\u2014', color: 'var(--v2-accent-amber)', bg: 'rgba(255,167,38,0.12)' },
  neutral: { label: 'NEUTRAL', arrow: '\u2014', color: 'var(--v2-accent-amber)', bg: 'rgba(255,167,38,0.12)' },
};

export default function SignalBadge({ direction = 'neutral', size = 'sm' }) {
  const config = BADGE_CONFIG[direction] || BADGE_CONFIG.neutral;

  return (
    <span
      className={`v2-signal-badge v2-signal-badge--${size}`}
      style={{ color: config.color, backgroundColor: config.bg }}
    >
      <span className="v2-signal-arrow">{config.arrow}</span>
      {config.label}
      <style>{`
        .v2-signal-badge {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          font-family: var(--v2-font-data);
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          border-radius: var(--v2-radius-full);
          white-space: nowrap;
        }
        .v2-signal-badge--sm {
          font-size: 10px;
          padding: 2px 8px;
        }
        .v2-signal-badge--md {
          font-size: 11px;
          padding: 3px 10px;
        }
        .v2-signal-arrow {
          font-size: 8px;
          line-height: 1;
        }
      `}</style>
    </span>
  );
}
