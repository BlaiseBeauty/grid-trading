import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries } from 'lightweight-charts';
import { api } from '../lib/api';

const SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];
const TIMEFRAMES = ['1h', '4h', '1d'];

export default function Chart() {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const [symbol, setSymbol] = useState('BTC-USDT');
  const [timeframe, setTimeframe] = useState('4h');

  // Create chart once
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
      crosshair: { mode: 0 },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.06)',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.06)',
      },
      handleScale: { mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#00ff88',
      downColor: '#ff2d55',
      borderUpColor: '#00ff88',
      borderDownColor: '#ff2d55',
      wickUpColor: '#00ff88',
      wickDownColor: '#ff2d55',
    });

    chartRef.current = chart;
    seriesRef.current = series;

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

  // Fetch data when symbol/timeframe changes
  useEffect(() => {
    async function loadData() {
      try {
        const candles = await api(`/market-data/${symbol}?timeframe=${timeframe}&limit=200`);
        if (!seriesRef.current || !candles?.length) return;

        const data = candles
          .map(c => ({
            time: Math.floor(new Date(c.timestamp).getTime() / 1000),
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
          }))
          .sort((a, b) => a.time - b.time);

        seriesRef.current.setData(data);
        chartRef.current?.timeScale().fitContent();
      } catch (err) {
        console.error('Chart data load failed:', err);
      }
    }
    loadData();
  }, [symbol, timeframe]);

  return (
    <div className="panel chart-panel">
      <div className="chart-header">
        <div className="panel-title">Price Chart</div>
        <div className="chart-controls">
          <div className="symbol-selector">
            {SYMBOLS.map(s => (
              <button
                key={s}
                className={`chart-btn ${symbol === s ? 'active' : ''}`}
                onClick={() => setSymbol(s)}
              >{s.split('-')[0]}</button>
            ))}
          </div>
          <div className="tf-selector">
            {TIMEFRAMES.map(tf => (
              <button
                key={tf}
                className={`chart-btn ${timeframe === tf ? 'active' : ''}`}
                onClick={() => setTimeframe(tf)}
              >{tf}</button>
            ))}
          </div>
        </div>
      </div>
      <div ref={containerRef} className="chart-container" />

      <style>{`
        .chart-panel { padding: 0; overflow: hidden; }
        .chart-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--space-md) var(--panel-padding);
          border-bottom: 1px solid var(--border-0);
        }
        .chart-header .panel-title { margin-bottom: 0; }
        .chart-controls { display: flex; gap: var(--space-md); }
        .symbol-selector, .tf-selector { display: flex; gap: 1px; }
        .chart-btn {
          padding: 4px 10px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          font-weight: 500;
          color: var(--t3);
          background: var(--elevated);
          border: 1px solid var(--border-0);
          transition: all var(--transition-fast);
        }
        .chart-btn:first-child { border-radius: var(--radius-sm) 0 0 var(--radius-sm); }
        .chart-btn:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
        .chart-btn.active {
          color: var(--cyan);
          background: rgba(0,229,255,0.08);
          border-color: rgba(0,229,255,0.2);
        }
        .chart-btn:hover:not(.active) { color: var(--t1); }
        .chart-container { width: 100%; height: 400px; }
      `}</style>
    </div>
  );
}
