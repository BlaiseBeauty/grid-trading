import { useCallback, useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries } from 'lightweight-charts';
import { api } from '../lib/api';
import { useDataStore } from '../stores/data';
import { StatusPulse, TickingNumber } from './ui';
import { getChartOptions, getCandlestickOptions, getPriceLineOptions, useChartTheme } from '../lib/chartConfig';

const SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];

function MiniChart({ symbol }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const price = useDataStore(s => s.prices[symbol]);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const chart = createChart(containerRef.current, {
      ...getChartOptions(),
    });

    const series = chart.addSeries(CandlestickSeries, {
      ...getCandlestickOptions(),
    });

    series.applyOptions({
      lastValueVisible: true,
      priceLineVisible: true,
      ...getPriceLineOptions(),
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

  // Re-apply colours when the theme switches
  useChartTheme(() => [
    [chartRef.current, getChartOptions],
    [seriesRef.current, () => ({ ...getCandlestickOptions(), ...getPriceLineOptions() })],
  ]);

  const loadData = useCallback(async () => {
    setLoadError(null);
    try {
      const candles = await api(`/market-data/${symbol}?timeframe=5m&limit=200`);
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
      setLoadError(err?.message || 'Failed to load candles');
    }
  }, [symbol]);

  useEffect(() => { loadData(); }, [loadData]);

  const ticker = symbol.split('-')[0];
  const currentPrice = price?.price;
  const change24h = price?.change24h;
  const hasChange = change24h != null;

  return (
    <div className="v2-mini-chart">
      <div className="v2-chart-ticker">
        <div className="v2-ticker-left">
          <span className="v2-ticker-symbol">{ticker}</span>
          <span className="v2-ticker-pair">/ USDT</span>
          {price && <StatusPulse status="active" size={5} />}
        </div>
        <div className="v2-ticker-right">
          {currentPrice != null
            ? <TickingNumber value={currentPrice} format="money" decimals={2} colorize={false} className="v2-ticker-price" />
            : <span className="v2-ticker-price">{'\u2014'}</span>
          }
          {hasChange && (
            <TickingNumber value={change24h} format="pct" decimals={2} className="v2-ticker-change" />
          )}
        </div>
      </div>
      {loadError && (
        <div className="state-block state-block--error" role="alert" style={{ padding: '6px 12px', flexDirection: 'row', gap: 8 }}>
          <span>Chart data failed to load</span>
          <button type="button" className="state-block__btn" onClick={loadData}>Retry</button>
        </div>
      )}
      <div ref={containerRef} className="v2-chart-container" />
    </div>
  );
}

export default function Chart() {
  return (
    <div className="v2-chart-row">
      {SYMBOLS.map(s => <MiniChart key={s} symbol={s} />)}

      <style>{`
        .v2-chart-row {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: var(--v2-space-lg);
        }
        .v2-mini-chart {
          background: var(--v2-glass-bg);
          backdrop-filter: var(--v2-glass-blur);
          border: 1px solid var(--v2-border);
          border-radius: var(--v2-radius-md);
          overflow: hidden;
          transition: border-color var(--v2-duration-normal) var(--v2-ease-out);
        }
        .v2-mini-chart:hover {
          border-color: var(--v2-border-hover);
        }
        .v2-chart-ticker {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--v2-space-sm) var(--v2-space-md);
          border-bottom: 1px solid var(--v2-border);
        }
        .v2-ticker-left {
          display: flex;
          align-items: center;
          gap: var(--v2-space-xs);
        }
        .v2-ticker-symbol {
          font-family: var(--v2-font-data);
          font-weight: 600;
          font-size: 14px;
          color: var(--v2-text-primary);
        }
        .v2-ticker-pair {
          font-family: var(--v2-font-data);
          font-size: 10px;
          color: var(--v2-text-muted);
        }
        .v2-ticker-right {
          display: flex;
          align-items: baseline;
          gap: var(--v2-space-sm);
        }
        .v2-ticker-price {
          font-family: var(--v2-font-data);
          font-size: 16px;
          font-weight: 500;
          font-variant-numeric: tabular-nums;
          color: var(--v2-text-primary);
        }
        .v2-ticker-change {
          font-family: var(--v2-font-data);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }
        .v2-ticker-change.v2-profit { color: var(--v2-accent-green); }
        .v2-ticker-change.v2-loss { color: var(--v2-accent-red); }
        .v2-chart-container { width: 100%; height: 260px; }
      `}</style>
    </div>
  );
}
