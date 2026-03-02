import { useEffect, useState } from 'react';

/**
 * ProgressRing — Circular SVG progress indicator.
 *
 * Props:
 *   value       (number, 0-100) — fill percentage
 *   size        (number, default 64) — diameter in px
 *   strokeWidth (number, default 4)
 *   color       (string, default 'var(--v2-accent-cyan)')
 *   trackColor  (string, default 'rgba(255,255,255,0.06)')
 *   label       (string, optional) — shown in center instead of value
 */
export default function ProgressRing({
  value = 0,
  size = 64,
  strokeWidth = 4,
  color = 'var(--v2-accent-cyan)',
  trackColor = 'rgba(255,255,255,0.06)',
  label,
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div className="v2-progress-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={trackColor}
          strokeWidth={strokeWidth}
        />
        {/* Progress */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={mounted ? offset : circumference}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{
            transition: `stroke-dashoffset var(--v2-duration-slow) var(--v2-ease-out)`,
          }}
        />
      </svg>
      <span className="v2-progress-ring-label" style={{ color }}>
        {label ?? `${Math.round(clamped)}%`}
      </span>
      <style>{`
        .v2-progress-ring {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .v2-progress-ring svg {
          display: block;
        }
        .v2-progress-ring-label {
          position: absolute;
          font-family: var(--v2-font-data);
          font-weight: 500;
          font-size: ${Math.max(10, size / 5)}px;
          font-variant-numeric: tabular-nums;
        }
      `}</style>
    </div>
  );
}
