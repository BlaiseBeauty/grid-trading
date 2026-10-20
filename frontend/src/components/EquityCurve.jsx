import { useEffect, useRef } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';
import { getChartOptions, getEquityAreaOptions, useChartTheme } from '../lib/chartConfig';
import { ErrorState } from './StateBlock';

// `loaded` = the equity request has completed at least once; `error` = last request failed.
// An empty curve is only shown as "no data" when the server confirmed there is none.
export default function EquityCurve({ data, loaded = true, error = null, onRetry }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  // Create chart on mount
  useEffect(() => {
    if (!containerRef.current) return undefined;

    const base = getChartOptions();
    const chart = createChart(containerRef.current, {
      ...base,
      layout: { ...base.layout, fontSize: 11 },
    });

    const areaSeries = chart.addSeries(AreaSeries, {
      ...getEquityAreaOptions(),
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

  useChartTheme(() => [
    [chartRef.current?.chart, () => ({ ...getChartOptions(), layout: { ...getChartOptions().layout, fontSize: 11 } })],
    [chartRef.current?.areaSeries, getEquityAreaOptions],
  ]);

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
      {!hasData && error && (
        <ErrorState error={error} onRetry={onRetry} title="Could not load equity curve" />
      )}
      {!hasData && !error && !loaded && (
        <div className="v2-equity-empty" role="status">Loading equity curve…</div>
      )}
      {!hasData && !error && loaded && (
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
