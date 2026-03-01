import { useEffect, useRef, useState } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';
import { api } from '../lib/api';

export default function EquityCurve() {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const [hasData, setHasData] = useState(true);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#0d0f15' },
        textColor: '#6e7590',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.03)' },
        horzLines: { color: 'rgba(255,255,255,0.03)' },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.06)',
        timeVisible: true,
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.06)',
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

    async function loadData() {
      try {
        const snapshots = await api('/system/equity');
        if (!snapshots?.length) {
          setHasData(false);
          return;
        }
        setHasData(true);
        const data = snapshots.map(s => ({
          time: Math.floor(new Date(s.created_at).getTime() / 1000),
          value: parseFloat(s.total_value),
        }));
        areaSeries.setData(data);
        chart.timeScale().fitContent();
      } catch (err) {
        console.error('Equity curve load failed:', err);
        setHasData(false);
      }
    }

    loadData();

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

  return (
    <div className="panel equity-panel">
      <div className="equity-header">
        <div className="panel-title">Equity Curve</div>
      </div>
      {!hasData ? (
        <div className="empty-state">No equity data yet — run a cycle to start tracking</div>
      ) : null}
      <div ref={containerRef} className="equity-container" style={{ display: hasData ? 'block' : 'none' }} />

      <style>{`
        .equity-panel { padding: 0; overflow: hidden; }
        .equity-header {
          padding: var(--space-md) var(--panel-padding);
          border-bottom: 1px solid var(--border-0);
        }
        .equity-header .panel-title { margin-bottom: 0; }
        .equity-container { width: 100%; height: 220px; }
      `}</style>
    </div>
  );
}
