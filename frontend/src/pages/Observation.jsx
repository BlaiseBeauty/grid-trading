import { useEffect, useRef, useState } from 'react';
import { createChart, LineSeries } from 'lightweight-charts';
import { api } from '../lib/api';
import {
  fmtMoney, fmtSignedPct, fmtNumber, fmtTrillions, timeAgo,
} from '../lib/format';
import { getChartOptions, getChartColors, useChartTheme } from '../lib/chartConfig';
import { ErrorState } from '../components/StateBlock';

// All number formatting lives in lib/format.jsx (U+2212 minus, tabular figures via the .num class).

// ── Fear & Greed gauge ────────────────────────────────────────────────────────

// Sentiment zones are not profit/loss, so they use neutral/amber/cyan, never green/red.
function FearGreedGauge({ value, label }) {
  const pct = value != null ? Math.min(100, Math.max(0, Number(value))) : null;

  const color =
    pct == null   ? 'var(--v2-text-muted)' :
    pct <= 45     ? 'var(--v2-accent-amber)' :
    pct <= 55     ? 'var(--v2-text-primary)' :
                    'var(--v2-accent-cyan)';

  const zone =
    pct == null   ? 'No data' :
    pct <= 25     ? 'Extreme Fear' :
    pct <= 45     ? 'Fear' :
    pct <= 55     ? 'Neutral' :
    pct <= 75     ? 'Greed' :
                    'Extreme Greed';

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        position: 'relative', width: 120, height: 60, margin: '0 auto',
        overflow: 'hidden',
      }}>
        {/* Arc background */}
        <svg width="120" height="60" viewBox="0 0 120 60" role="img" aria-label={pct != null ? `Fear and greed index ${pct}, ${zone}` : 'Fear and greed index unavailable'}>
          <path d="M10,60 A50,50 0 0,1 110,60" fill="none" stroke="var(--v2-border-hover)" strokeWidth="10" />
          {pct != null && (
            <path
              d="M10,60 A50,50 0 0,1 110,60"
              fill="none"
              stroke={color}
              strokeWidth="10"
              strokeDasharray={`${(pct / 100) * 157} 157`}
              style={{ transition: 'stroke-dasharray 0.6s ease' }}
            />
          )}
        </svg>
        <div className="num" style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          textAlign: 'center',
          fontSize: 28, fontWeight: 700,
          color: pct != null ? color : 'var(--v2-text-muted)',
        }}>
          {pct != null ? pct : '—'}
        </div>
      </div>
      <div style={{ marginTop: 4, fontFamily: 'var(--v2-font-data)', fontSize: 11, color }}>
        {zone}
      </div>
      {label && label !== zone && (
        <div style={{ fontSize: 10, color: 'var(--v2-text-muted)', marginTop: 2 }}>{label}</div>
      )}
    </div>
  );
}

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, subTone, accent }) {
  // subTone: 'profit' | 'loss' | undefined, decided from the number by the caller (never from a text prefix)
  const subColor = subTone === 'profit' ? 'var(--v2-accent-green)'
    : subTone === 'loss' ? 'var(--v2-accent-red)'
    : 'var(--v2-text-secondary)';
  return (
    <div style={{
      background: 'var(--v2-bg-secondary)',
      border: '1px solid var(--v2-border)',
      borderRadius: 8,
      padding: '14px 16px',
      borderLeft: accent ? `3px solid ${accent}` : undefined,
    }}>
      <div style={{ fontFamily: 'var(--v2-font-data)', fontSize: 10, color: 'var(--v2-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 6 }}>
        {label}
      </div>
      <div className="num" style={{ fontFamily: 'var(--v2-font-data)', fontSize: 20, fontWeight: 700, color: 'var(--v2-text-primary)', lineHeight: 1 }}>
        {value}
      </div>
      {sub && (
        <div className="num" style={{ fontSize: 11, color: subColor, marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function tone(n) {
  const v = parseFloat(n);
  if (!Number.isFinite(v)) return undefined;
  return v >= 0 ? 'profit' : 'loss';
}

// ── BTC Price Chart ───────────────────────────────────────────────────────────

function BtcChart({ history }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !history?.length) return undefined;

    const chart = createChart(containerRef.current, {
      ...getChartOptions(),
      layout: { ...getChartOptions().layout, fontSize: 11 },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addSeries(LineSeries, {
      color: getChartColors().cyan,
      lineWidth: 2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    // Build sorted data points from history (oldest first)
    const points = [...history]
      .filter(r => r.btc_price != null)
      .sort((a, b) => new Date(a.observed_at) - new Date(b.observed_at))
      .map(r => ({
        time: Math.floor(new Date(r.observed_at).getTime() / 1000),
        value: parseFloat(r.btc_price),
      }));

    series.setData(points);
    chart.timeScale().fitContent();
    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [history]);

  // Re-apply colours when the theme switches
  useChartTheme(() => [
    [chartRef.current, () => ({ ...getChartOptions(), handleScroll: false, handleScale: false })],
    [seriesRef.current, () => ({ color: getChartColors().cyan })],
  ]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: 220 }} />
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Observation() {
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [collectError, setCollectError] = useState(null);
  const [collecting, setCollecting] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);

  async function load() {
    setLoadError(null);
    try {
      const [latestData, historyData] = await Promise.all([
        api('/observation/latest'),
        api('/observation/history'),
      ]);
      if (!latestData.error) setLatest(latestData);
      setHistory(historyData || []);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('[OBS] Load failed:', err.message);
      setLoadError(err.message || 'Failed to load observations');
    } finally {
      setLoading(false);
    }
  }

  async function triggerCollection() {
    if (collecting) return;
    setCollecting(true);
    setCollectError(null);
    try {
      await api('/observation/collect', { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (err) {
      console.error('[OBS] Collection failed:', err.message);
      setCollectError(err.message || 'Collection failed');
    } finally {
      setCollecting(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(interval);
  }, []);

  const hasData = !!latest || history.length > 0;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>

      {/* ── Observation Mode Banner — neutral UI colour: green is reserved for profit/loss ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
        background: 'var(--v2-tint-cyan)',
        border: '1px solid var(--v2-border)',
        borderRadius: 8, padding: '10px 16px',
        marginBottom: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--v2-accent-cyan)',
            display: 'inline-block',
            animation: 'obs-pulse 2s ease-in-out infinite',
          }} />
          <span style={{
            fontFamily: 'var(--v2-font-data)', fontSize: 13, fontWeight: 600,
            color: 'var(--v2-accent-cyan)', letterSpacing: '0.5px',
          }}>
            Observation Mode — No trades executing
          </span>
          <span style={{ fontSize: 11, color: 'var(--v2-text-secondary)', marginLeft: 4 }}>
            · Collecting every 6h · Zero AI spend
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {lastRefresh && (
            <span style={{ fontSize: 11, color: 'var(--v2-text-muted)', fontFamily: 'var(--v2-font-data)' }}>
              refreshed {timeAgo(lastRefresh)}
            </span>
          )}
          <button
            type="button"
            onClick={triggerCollection}
            disabled={collecting}
            style={{
              background: 'var(--v2-tint-cyan)',
              border: '1px solid var(--v2-tint-cyan-strong)',
              borderRadius: 6, padding: '5px 12px',
              color: 'var(--v2-accent-cyan)',
              fontFamily: 'var(--v2-font-data)', fontSize: 11,
              cursor: collecting ? 'not-allowed' : 'pointer',
              opacity: collecting ? 0.5 : 1,
            }}
          >
            {collecting ? 'Collecting…' : '↻ Collect now'}
          </button>
        </div>
      </div>

      {collectError && <ErrorState error={collectError} title="Collection failed" />}
      {loadError && (
        <ErrorState
          error={loadError}
          onRetry={load}
          title={hasData ? 'Refresh failed — showing the last loaded data' : 'Could not load observations'}
        />
      )}

      {loading ? (
        <div role="status" style={{ color: 'var(--v2-text-secondary)', fontFamily: 'var(--v2-font-data)', fontSize: 13, padding: 40, textAlign: 'center' }}>
          Loading observations…
        </div>
      ) : (
        <>
          {/* ── Crypto cards row ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 12, marginBottom: 12 }}>
            <MetricCard
              label="Bitcoin (BTC)"
              value={fmtMoney(latest?.btc_price, 0)}
              sub={latest?.btc_change_24h != null ? `${fmtSignedPct(latest.btc_change_24h)} 24h` : undefined}
              subTone={tone(latest?.btc_change_24h)}
              accent="var(--v2-accent-cyan)"
            />
            <MetricCard
              label="Ethereum (ETH)"
              value={fmtMoney(latest?.eth_price, 0)}
              sub={latest?.eth_change_24h != null ? `${fmtSignedPct(latest.eth_change_24h)} 24h` : undefined}
              subTone={tone(latest?.eth_change_24h)}
              accent="var(--v2-accent-magenta)"
            />
            <MetricCard
              label="Total Market Cap"
              value={fmtTrillions(latest?.total_market_cap)}
              sub={latest?.btc_dominance != null ? `BTC dom ${fmtNumber(latest.btc_dominance, 1)}%` : undefined}
              accent="var(--v2-accent-amber)"
            />
          </div>

          {/* ── Macro cards row ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 12, marginBottom: 24 }}>
            <MetricCard
              label="USD Index (DXY)"
              value={fmtNumber(latest?.dxy, 2)}
              accent="var(--v2-border-active)"
            />
            <MetricCard
              label="10Y Treasury Yield"
              value={latest?.treasury_10y != null ? `${fmtNumber(latest.treasury_10y, 2)}%` : '—'}
              accent="var(--v2-border-active)"
            />
            <MetricCard
              label="Gold (USD / troy oz)"
              value={fmtMoney(latest?.gold_price, 0)}
              accent="var(--v2-accent-amber)"
            />
          </div>

          {/* ── Chart + Fear & Greed row ── */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
            {/* BTC Price Chart */}
            <div style={{
              background: 'var(--v2-bg-secondary)',
              border: '1px solid var(--v2-border)',
              borderRadius: 8, padding: '16px',
              flex: '3 1 320px',
              minWidth: 0,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12,
              }}>
                <span style={{ fontFamily: 'var(--v2-font-data)', fontSize: 11, color: 'var(--v2-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                  BTC Price — 7d
                </span>
                <span className="num" style={{ fontFamily: 'var(--v2-font-data)', fontSize: 11, color: 'var(--v2-text-muted)' }}>
                  {history.length} observations
                </span>
              </div>
              {history.length > 0 ? (
                <BtcChart history={history} />
              ) : (
                <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--v2-text-muted)', fontSize: 13 }}>
                  {loadError ? 'Chart unavailable' : 'Collecting first data points…'}
                </div>
              )}
            </div>

            {/* Fear & Greed */}
            <div style={{
              background: 'var(--v2-bg-secondary)',
              border: '1px solid var(--v2-border)',
              borderRadius: 8, padding: '16px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
              flex: '1 1 200px',
            }}>
              <div style={{ fontFamily: 'var(--v2-font-data)', fontSize: 11, color: 'var(--v2-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                Fear & Greed
              </div>
              <FearGreedGauge value={latest?.fear_greed_value} label={latest?.fear_greed_label} />
            </div>
          </div>

          {/* ── History table ── */}
          {history.length > 0 && (
            <div style={{
              background: 'var(--v2-bg-secondary)',
              border: '1px solid var(--v2-border)',
              borderRadius: 8, overflow: 'hidden',
            }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--v2-border)' }}>
                <span style={{ fontFamily: 'var(--v2-font-data)', fontSize: 11, color: 'var(--v2-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                  Observation History
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--v2-font-data)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                  <thead>
                    <tr style={{ background: 'var(--v2-bg-tertiary)' }}>
                      {['Time', 'BTC', '24h', 'ETH', '24h', 'Mkt Cap', 'Dom%', 'F&G', 'DXY', '10Y', 'Gold'].map((h, hi) => (
                        <th key={`${h}-${hi}`} scope="col" style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--v2-text-secondary)', fontWeight: 500, letterSpacing: '0.5px', fontSize: 10, textTransform: 'uppercase', borderBottom: '1px solid var(--v2-border)', whiteSpace: 'nowrap' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row, i) => {
                      const btcChg = Number(row.btc_change_24h);
                      const ethChg = Number(row.eth_change_24h);
                      const fg = parseFloat(row.fear_greed_value);
                      return (
                        <tr key={row.id} style={{ borderBottom: i < history.length - 1 ? '1px solid var(--v2-border)' : 'none', background: i % 2 === 0 ? 'transparent' : 'var(--v2-fill-1)' }}>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)', whiteSpace: 'nowrap' }}>
                            {timeAgo(row.observed_at)}
                          </td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-primary)' }}>{fmtMoney(row.btc_price, 0)}</td>
                          <td style={{ padding: '7px 12px', color: btcChg >= 0 ? 'var(--v2-accent-green)' : 'var(--v2-accent-red)' }}>{fmtSignedPct(row.btc_change_24h)}</td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-primary)' }}>{fmtMoney(row.eth_price, 0)}</td>
                          <td style={{ padding: '7px 12px', color: ethChg >= 0 ? 'var(--v2-accent-green)' : 'var(--v2-accent-red)' }}>{fmtSignedPct(row.eth_change_24h)}</td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)' }}>{fmtTrillions(row.total_market_cap)}</td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)' }}>{fmtNumber(row.btc_dominance, 1)}</td>
                          <td style={{ padding: '7px 12px' }}>
                            <span style={{ color: fg <= 45 ? 'var(--v2-accent-amber)' : fg >= 55 ? 'var(--v2-accent-cyan)' : 'var(--v2-text-secondary)' }}>
                              {Number.isFinite(fg) ? fg : '—'}
                            </span>
                          </td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)' }}>{fmtNumber(row.dxy, 2)}</td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)' }}>{row.treasury_10y != null ? `${fmtNumber(row.treasury_10y, 2)}%` : '—'}</td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)' }}>{fmtMoney(row.gold_price, 0)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!hasData && !loadError && (
            <div style={{
              textAlign: 'center', padding: 60,
              color: 'var(--v2-text-secondary)', fontFamily: 'var(--v2-font-data)', fontSize: 13,
            }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>◎</div>
              <div>First collection running on boot — check back in a moment</div>
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--v2-text-muted)' }}>
                Or click <strong style={{ color: 'var(--v2-accent-cyan)' }}>Collect now</strong> to trigger immediately
              </div>
            </div>
          )}
        </>
      )}

      <style>{`
        @keyframes obs-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.6; transform: scale(0.85); }
        }
      `}</style>
    </div>
  );
}
