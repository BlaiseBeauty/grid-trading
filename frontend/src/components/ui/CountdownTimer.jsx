import { useEffect, useState } from 'react';

/**
 * CountdownTimer — Live countdown to a target time.
 *
 * Props:
 *   targetTime  (Date | number) — target timestamp (Date object or unix ms)
 *   label       (string, optional) — text label before the timer
 *   onComplete  (function, optional) — called when countdown reaches 0
 */
export default function CountdownTimer({ targetTime, label, onComplete }) {
  const [remaining, setRemaining] = useState(() => calcRemaining(targetTime));

  useEffect(() => {
    const interval = setInterval(() => {
      const r = calcRemaining(targetTime);
      setRemaining(r);
      if (r <= 0) {
        clearInterval(interval);
        onComplete?.();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [targetTime, onComplete]);

  const urgent = remaining > 0 && remaining <= 60;
  const display = remaining <= 0 ? '00:00' : formatTime(remaining);

  return (
    <span className={`v2-countdown ${urgent ? 'v2-countdown--urgent' : ''}`}>
      {label && <span className="v2-countdown-label">{label}</span>}
      <span className="v2-countdown-time">{display}</span>
      <style>{`
        .v2-countdown {
          display: inline-flex;
          align-items: center;
          gap: var(--v2-space-sm);
        }
        .v2-countdown-label {
          font-family: var(--v2-font-body);
          font-size: 11px;
          color: var(--v2-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .v2-countdown-time {
          font-family: var(--v2-font-data);
          font-weight: 500;
          font-size: 13px;
          font-variant-numeric: tabular-nums;
          color: var(--v2-text-primary);
          letter-spacing: 1px;
        }
        .v2-countdown--urgent .v2-countdown-time {
          color: var(--v2-accent-amber);
          animation: v2-number-flash 1s ease-in-out infinite;
        }
      `}</style>
    </span>
  );
}

function calcRemaining(target) {
  if (!target) return 0;
  const t = target instanceof Date ? target.getTime() : Number(target);
  return Math.max(0, Math.floor((t - Date.now()) / 1000));
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');

  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}
