import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries } from 'lightweight-charts';
import { api } from '../lib/api';
import { useDataStore } from '../stores/data';

const SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];

function MiniChart({ symbol }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const prices = useDataStore(s => s.prices);
  const price = prices[symbol];

  // Create chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#0d0f15' },
        textColor: '#6e7590',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10,
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

  // Fetch candle data
  useEffect(() => {
    async function loadData() {
      try {
        const candles = await api(`/market-data/${symbol}?timeframe=4h&limit=200`);
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
        console.error(`Chart data load failed for ${symbol}:`, err);
      }
    }
    loadData();
  }, [symbol]);

  const ticker = symbol.split('-')[0];
  const currentPrice = price?.price;
  const change24h = price?.change24h;
  const hasChange = change24h != null;
  const isPositive = change24h >= 0;

  return (
    <div className="mini-chart-card">
      <div className="mini-chart-ticker">
        <div className="ticker-left">
          <span className="ticker-symbol">{ticker}</span>
          <span className="ticker-pair">/ USDT</span>
          <span className={`live-dot ${price ? 'live' : ''}`} />
        </div>
        <div className="ticker-right">
          <span className="ticker-price">
            {currentPrice != null
              ? `$${Number(currentPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : '—'}
          </span>
          {hasChange && (
            <span className={`ticker-change ${isPositive ? 'profit' : 'loss'}`}>
              {isPositive ? '+' : ''}{change24h.toFixed(2)}%
            </span>
          )}
        </div>
      </div>
      <div ref={containerRef} className="mini-chart-container" />
    </div>
  );
}

export default function Chart() {
  return (
    <div className="multi-chart-row">
      {SYMBOLS.map(s => <MiniChart key={s} symbol={s} />)}

      <style>{`
        .multi-chart-row {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: var(--panel-gap);
        }
        .mini-chart-card {
          background: var(--surface);
          border: 1px solid var(--border-1);
          border-radius: var(--radius-md);
          overflow: hidden;
        }
        .mini-chart-ticker {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--space-sm) var(--space-md);
          border-bottom: 1px solid var(--border-0);
        }
        .ticker-left {
          display: flex;
          align-items: center;
          gap: var(--space-xs);
        }
        .ticker-symbol {
          font-family: 'IBM Plex Mono', monospace;
          font-weight: 600;
          font-size: 14px;
          color: var(--t1);
        }
        .ticker-pair {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          color: var(--t4);
        }
        .live-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--t4);
          margin-left: var(--space-xs);
        }
        .live-dot.live {
          background: var(--cyan);
          box-shadow: 0 0 6px rgba(0, 229, 255, 0.6);
          animation: pulse-dot 2s ease-in-out infinite;
        }
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; box-shadow: 0 0 6px rgba(0, 229, 255, 0.6); }
          50% { opacity: 0.5; box-shadow: 0 0 2px rgba(0, 229, 255, 0.3); }
        }
        .ticker-right {
          display: flex;
          align-items: baseline;
          gap: var(--space-sm);
        }
        .ticker-price {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 16px;
          font-weight: 500;
          font-variant-numeric: tabular-nums;
          color: var(--t1);
        }
        .ticker-change {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }
        .ticker-change.profit { color: var(--green); }
        .ticker-change.loss { color: var(--red); }
        .mini-chart-container { width: 100%; height: 260px; }
      `}</style>
    </div>
  );
}
