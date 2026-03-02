/**
 * RangeBar — Horizontal bar showing price position between SL and TP.
 *
 * Props:
 *   current  (number) — current price
 *   low      (number) — stop-loss price
 *   high     (number) — take-profit price
 *   side     ('buy' | 'sell') — trade direction (swaps SL/TP color meaning)
 */
export default function RangeBar({ current, low, high, side = 'buy' }) {
  if (!low || !high || low >= high) return null;

  const range = high - low;
  const position = Math.max(0, Math.min(100, ((current - low) / range) * 100));

  // For longs: SL is low (red), TP is high (green)
  // For shorts: SL is high (red), TP is low (green)
  const slColor = 'var(--v2-accent-red)';
  const tpColor = 'var(--v2-accent-green)';
  const slLabel = side === 'buy' ? formatCompact(low) : formatCompact(high);
  const tpLabel = side === 'buy' ? formatCompact(high) : formatCompact(low);
  const leftColor = side === 'buy' ? slColor : tpColor;
  const rightColor = side === 'buy' ? tpColor : slColor;

  // Marker color: green if in profit zone, red if in loss zone
  const midPoint = 50;
  const inProfit = side === 'buy' ? position > midPoint : position < midPoint;
  const markerColor = inProfit ? 'var(--v2-accent-green)' : 'var(--v2-accent-red)';

  return (
    <div className="v2-range-bar">
      <span className="v2-range-label" style={{ color: leftColor }}>
        {side === 'buy' ? 'SL' : 'TP'} {side === 'buy' ? slLabel : tpLabel}
      </span>
      <div className="v2-range-track">
        <div
          className="v2-range-fill"
          style={{
            width: `${position}%`,
            background: `linear-gradient(90deg, ${leftColor}33, ${rightColor}33)`,
          }}
        />
        <div
          className="v2-range-marker"
          style={{ left: `${position}%`, backgroundColor: markerColor }}
        />
      </div>
      <span className="v2-range-label" style={{ color: rightColor }}>
        {side === 'buy' ? 'TP' : 'SL'} {side === 'buy' ? tpLabel : slLabel}
      </span>
      <style>{`
        .v2-range-bar {
          display: flex;
          align-items: center;
          gap: var(--v2-space-sm);
          width: 100%;
        }
        .v2-range-label {
          font-family: var(--v2-font-data);
          font-size: 9px;
          font-weight: 500;
          white-space: nowrap;
          min-width: 48px;
        }
        .v2-range-label:last-child {
          text-align: right;
        }
        .v2-range-track {
          flex: 1;
          height: 4px;
          background: var(--v2-border);
          border-radius: 2px;
          position: relative;
          overflow: visible;
        }
        .v2-range-fill {
          position: absolute;
          top: 0;
          left: 0;
          height: 100%;
          border-radius: 2px;
        }
        .v2-range-marker {
          position: absolute;
          top: 50%;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          transform: translate(-50%, -50%);
          box-shadow: 0 0 6px currentColor;
          transition: left var(--v2-duration-normal) var(--v2-ease-out);
        }
      `}</style>
    </div>
  );
}

function formatCompact(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1) return n.toFixed(1);
  return n.toFixed(4);
}
