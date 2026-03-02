import { useEffect, useRef } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';

export default function EquityCurve({ data }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  // Create chart on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: 'var(--v2-text-muted)',
        fontFamily: "var(--v2-font-data)",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.03)' },
        horzLines: { color: 'rgba(255,255,255,0.03)' },
      },
      timeScale: {
        borderColor: 'var(--v2-border)',
        timeVisible: true,
      },
      rightPriceScale: {
        borderColor: 'var(--v2-border)',
      },
      crosshair: { mode: 0 },
      handleScale: { mouseWheel: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
    });

    const areaSeries = chart.addSeries(AreaSeries, {
      topColor: 'rgba(0, 229, 255, 0.3)',
      bottomColor: 'rgba(0, 229, 255, 0.02)',
      lineColor: '#00e5ff',
      lineWidth: 2,
    });

    chartRef.current = { chart, areaSeries };

    const resizeObserver = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      chart.applyOptions({ width, height });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, []);

  // Update chart when data prop changes
  useEffect(() => {
    if (!chartRef.current || !data?.length) return;
    const chartData = data.map(s => ({
      time: Math.floor(new Date(s.created_at).getTime() / 1000),
      value: parseFloat(s.total_value),
    }));
    chartRef.current.areaSeries.setData(chartData);
    chartRef.current.chart.timeScale().fitContent();
  }, [data]);

  const hasData = data?.length > 0;

  return (
    <div className="v2-equity-panel">
      <div className="v2-equity-header">
        <div className="v2-equity-title">Equity Curve</div>
      </div>
      {!hasData && (
        <div className="v2-equity-empty">No equity data yet — run a cycle to start tracking</div>
      )}
      <div ref={containerRef} className="v2-equity-container" style={{ display: hasData ? 'block' : 'none' }} />

      <style>{`
        .v2-equity-panel {
          background: var(--v2-glass-bg);
          backdrop-filter: var(--v2-glass-blur);
          border: 1px solid var(--v2-border);
          border-radius: var(--v2-radius-md);
          overflow: hidden;
        }
        .v2-equity-header {
          padding: var(--v2-space-md) var(--v2-space-lg);
          border-bottom: 1px solid var(--v2-border);
        }
        .v2-equity-title {
          font-family: var(--v2-font-data);
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          color: var(--v2-text-muted);
        }
        .v2-equity-empty {
          color: var(--v2-text-muted);
          font-size: 13px;
          padding: var(--v2-space-xl);
          text-align: center;
        }
        .v2-equity-container { width: 100%; height: 220px; }
      `}</style>
    </div>
  );
}
