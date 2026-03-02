/**
 * GlowCard — Card with glass morphism background and glow-on-hover border.
 *
 * Props:
 *   children   — card content
 *   className  (string, optional)
 *   glowColor  ('cyan' | 'green' | 'red' | 'amber' | 'magenta', default 'cyan')
 *   onClick    (function, optional)
 *   padding    (string, default 'var(--v2-space-lg)')
 */
export default function GlowCard({
  children,
  className = '',
  glowColor = 'cyan',
  onClick,
  padding,
}) {
  return (
    <div
      className={`v2-glow-card v2-glow-card--${glowColor} ${className}`}
      onClick={onClick}
      style={padding ? { padding } : undefined}
    >
      {children}
      <style>{`
        .v2-glow-card {
          background: var(--v2-glass-bg);
          backdrop-filter: var(--v2-glass-blur);
          -webkit-backdrop-filter: var(--v2-glass-blur);
          border: 1px solid var(--v2-border);
          border-radius: var(--v2-radius-md);
          padding: var(--v2-space-lg);
          transition:
            border-color var(--v2-duration-normal) var(--v2-ease-out),
            box-shadow var(--v2-duration-normal) var(--v2-ease-out),
            background var(--v2-duration-normal) var(--v2-ease-out);
        }
        .v2-glow-card:hover {
          border-color: var(--v2-border-hover);
          background: var(--v2-bg-card);
        }
        .v2-glow-card[onClick] { cursor: pointer; }

        .v2-glow-card--cyan:hover  { box-shadow: var(--v2-glow-cyan); }
        .v2-glow-card--green:hover { box-shadow: var(--v2-glow-green); }
        .v2-glow-card--red:hover   { box-shadow: var(--v2-glow-red); }
        .v2-glow-card--amber:hover { box-shadow: var(--v2-glow-amber); }
        .v2-glow-card--magenta:hover { box-shadow: var(--v2-glow-magenta); }
      `}</style>
    </div>
  );
}
