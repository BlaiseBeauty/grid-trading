import { useEffect, useRef, useState } from 'react';
import { fmtMoney, fmtNumber, fmtSignedPct } from '../../lib/format';

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    console.warn('[TickingNumber] matchMedia unavailable:', err?.message || err);
    return false;
  }
}

/**
 * TickingNumber — Animates between numeric values using requestAnimationFrame.
 *
 * Props:
 *   value      (number)  — target value
 *   format     ('money' | 'pct' | 'number') — display format
 *   decimals   (number, default 2)
 *   duration   (number, default 400) — animation duration in ms
 *   flash      (boolean, default true) — glow on change
 *   prefix     (string, optional) — custom prefix
 *   className  (string, optional)
 *   colorize   (boolean, default true) — green/red based on sign
 */
export default function TickingNumber({
  value = 0,
  format = 'number',
  decimals = 2,
  duration = 300,
  flash = true,
  prefix,
  className = '',
  colorize = true,
}) {
  const [display, setDisplay] = useState(value);
  const [flashing, setFlashing] = useState(null);
  const prevRef = useRef(value);
  const rafRef = useRef(null);

  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    prevRef.current = value;

    if (from === to) return;

    // Reduced motion: jump straight to the value, no tween and no flash
    if (prefersReducedMotion()) {
      setDisplay(to);
      return;
    }

    // Determine flash direction
    if (flash) {
      setFlashing(to > from ? 'green' : 'red');
    }

    const start = performance.now();
    let flashTimer = null;

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (to - from) * eased);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(to);
        // Clear flash after animation
        if (flash) {
          flashTimer = setTimeout(() => setFlashing(null), 100);
        }
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [value, duration, flash]);

  const formatted = formatValue(display, format, decimals, prefix);
  const color = colorize
    ? display > 0.001 ? 'var(--v2-accent-green)'
    : display < -0.001 ? 'var(--v2-accent-red)'
    : 'var(--v2-text-primary)'
    : undefined;

  const flashClass = flashing === 'green' ? 'v2-flash-green'
    : flashing === 'red' ? 'v2-flash-red'
    : '';

  return (
    <span
      className={`v2-ticking-number ${flashClass} ${className}`}
      style={{ color, fontVariantNumeric: 'tabular-nums' }}
    >
      {formatted}
      <style>{`
        .v2-ticking-number {
          font-family: var(--v2-font-data);
          display: inline-block;
          padding: 0 2px;
          border-radius: 3px;
          transition: color var(--v2-duration-fast) var(--v2-ease-out);
        }
      `}</style>
    </span>
  );
}

// Formatting is delegated to lib/format.jsx (U+2212 minus, grouping, em dash for invalid).
function formatValue(val, format, decimals, prefix) {
  switch (format) {
    case 'money':
      return fmtMoney(val, decimals, prefix ?? '$');
    case 'pct':
      return fmtSignedPct(val, decimals);
    default:
      return fmtNumber(val, decimals, prefix ?? '');
  }
}
