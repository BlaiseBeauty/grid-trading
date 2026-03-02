import { useMemo } from 'react';

/**
 * Sparkline — Tiny inline SVG chart.
 *
 * Props:
 *   data    (number[]) — values to plot
 *   width   (number, default 80)
 *   height  (number, default 24)
 *   color   (string, default 'var(--v2-accent-cyan)')
 *   filled  (boolean, default false) — gradient fill below line
 */
export default function Sparkline({
  data = [],
  width = 80,
  height = 24,
  color = 'var(--v2-accent-cyan)',
  filled = false,
}) {
  const { linePath, fillPath, gradientId } = useMemo(() => {
    if (data.length < 2) return { linePath: '', fillPath: '', gradientId: '' };

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const padding = 1;
    const drawHeight = height - padding * 2;
    const stepX = (width - 2) / (data.length - 1);

    const points = data.map((v, i) => {
      const x = 1 + i * stepX;
      const y = padding + drawHeight - ((v - min) / range) * drawHeight;
      return { x, y };
    });

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const fill = line + ` L${points[points.length - 1].x.toFixed(1)},${height} L${points[0].x.toFixed(1)},${height} Z`;
    const id = `sparkline-grad-${Math.random().toString(36).slice(2, 8)}`;

    return { linePath: line, fillPath: fill, gradientId: id };
  }, [data, width, height]);

  if (data.length < 2) {
    return <svg width={width} height={height} />;
  }

  return (
    <svg
      width={width}
      height={height}
      className="v2-sparkline"
      viewBox={`0 0 ${width} ${height}`}
    >
      {filled && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.2" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={fillPath} fill={`url(#${gradientId})`} />
        </>
      )}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <style>{`
        .v2-sparkline {
          display: inline-block;
          vertical-align: middle;
        }
      `}</style>
    </svg>
  );
}
