import { useEffect, useRef, useState } from 'react';
import { createChart, LineSeries } from 'lightweight-charts';
import { api } from '../lib/api';

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtUSD(n, decimals = 0) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtPct(n) {
  if (n == null) return '—';
  const num = Number(n);
  return (num >= 0 ? '+' : '') + num.toFixed(2) + '%';
}

function fmtCap(n) {
  if (n == null) return '—';
  const t = Number(n) / 1e12;
  return '$' + t.toFixed(2) + 'T';
}

function fmtNum(n, d = 2) {
  if (n == null) return '—';
  return Number(n).toFixed(d);
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Fear & Greed gauge ────────────────────────────────────────────────────────

function FearGreedGauge({ value, label }) {
  const pct = value != null ? Math.min(100, Math.max(0, Number(value))) : null;

  const color =
    pct == null   ? '#5c5f6b' :
    pct <= 25     ? '#ef5350' :
    pct <= 45     ? '#ffa726' :
    pct <= 55     ? '#e0e2e7' :
    pct <= 75     ? '#66bb6a' :
                    '#4fc3f7';

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
        <svg width="120" height="60" viewBox="0 0 120 60">
          <path d="M10,60 A50,50 0 0,1 110,60" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="10" />
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
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          textAlign: 'center',
          fontFamily: 'var(--v2-font-data)',
          fontSize: 28, fontWeight: 700,
          color: pct != null ? color : '#5c5f6b',
        }}>
          {pct != null ? pct : '—'}
        </div>
      </div>
      <div style={{ marginTop: 4, fontFamily: 'var(--v2-font-data)', fontSize: 11, color }}>
        {zone}
      </div>
      {label && label !== zone && (
        <div style={{ fontSize: 10, color: '#5c5f6b', marginTop: 2 }}>{label}</div>
      )}
    </div>
  );
}

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, accent }) {
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
      <div style={{ fontFamily: 'var(--v2-font-data)', fontSize: 20, fontWeight: 700, color: 'var(--v2-text-primary)', lineHeight: 1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: sub.startsWith('+') ? 'var(--v2-accent-green)' : sub.startsWith('-') ? 'var(--v2-accent-red)' : 'var(--v2-text-secondary)', marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ── BTC Price Chart ───────────────────────────────────────────────────────────

function BtcChart({ history }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !history?.length) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#8b8e99',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.07)',
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.07)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.2)' },
        horzLine: { color: 'rgba(255,255,255,0.2)' },
      },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addSeries(LineSeries, {
      color: '#4fc3f7',
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
    };
  }, [history]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: 220 }} />
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Observation() {
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);

  async function load() {
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
    } finally {
      setLoading(false);
    }
  }

  async function triggerCollection() {
    if (collecting) return;
    setCollecting(true);
    try {
      await api('/observation/collect', { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (err) {
      console.error('[OBS] Collection failed:', err.message);
    } finally {
      setCollecting(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>

      {/* ── Observation Mode Banner ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'rgba(102,187,106,0.08)',
        border: '1px solid rgba(102,187,106,0.25)',
        borderRadius: 8, padding: '10px 16px',
        marginBottom: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: '#66bb6a',
            boxShadow: '0 0 8px rgba(102,187,106,0.6)',
            display: 'inline-block',
            animation: 'obs-pulse 2s ease-in-out infinite',
          }} />
          <span style={{
            fontFamily: 'var(--v2-font-data)', fontSize: 13, fontWeight: 600,
            color: '#66bb6a', letterSpacing: '0.5px',
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
            onClick={triggerCollection}
            disabled={collecting}
            style={{
              background: 'rgba(79,195,247,0.1)',
              border: '1px solid rgba(79,195,247,0.3)',
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

      {loading ? (
        <div style={{ color: 'var(--v2-text-secondary)', fontFamily: 'var(--v2-font-data)', fontSize: 13, padding: 40, textAlign: 'center' }}>
          Loading observations…
        </div>
      ) : (
        <>
          {/* ── Crypto cards row ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
            <MetricCard
              label="Bitcoin (BTC)"
              value={fmtUSD(latest?.btc_price)}
              sub={latest?.btc_change_24h != null ? fmtPct(latest.btc_change_24h) + ' 24h' : undefined}
              accent="var(--v2-accent-cyan)"
            />
            <MetricCard
              label="Ethereum (ETH)"
              value={fmtUSD(latest?.eth_price)}
              sub={latest?.eth_change_24h != null ? fmtPct(latest.eth_change_24h) + ' 24h' : undefined}
              accent="var(--v2-accent-magenta)"
            />
            <MetricCard
              label="Total Market Cap"
              value={fmtCap(latest?.total_market_cap)}
              sub={latest?.btc_dominance != null ? `BTC dom ${fmtNum(latest.btc_dominance, 1)}%` : undefined}
              accent="var(--v2-accent-amber)"
            />
          </div>

          {/* ── Macro cards row ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
            <MetricCard
              label="USD Index (DXY)"
              value={fmtNum(latest?.dxy, 2)}
              accent="rgba(255,255,255,0.3)"
            />
            <MetricCard
              label="10Y Treasury Yield"
              value={latest?.treasury_10y != null ? fmtNum(latest.treasury_10y, 2) + '%' : '—'}
              accent="rgba(255,255,255,0.3)"
            />
            <MetricCard
              label="Gold (USD / troy oz)"
              value={fmtUSD(latest?.gold_price)}
              accent="rgba(255,167,38,0.5)"
            />
          </div>

          {/* ── Chart + Fear & Greed row ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 16, marginBottom: 24 }}>
            {/* BTC Price Chart */}
            <div style={{
              background: 'var(--v2-bg-secondary)',
              border: '1px solid var(--v2-border)',
              borderRadius: 8, padding: '16px',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12,
              }}>
                <span style={{ fontFamily: 'var(--v2-font-data)', fontSize: 11, color: 'var(--v2-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                  BTC Price — 7d
                </span>
                <span style={{ fontFamily: 'var(--v2-font-data)', fontSize: 11, color: 'var(--v2-text-muted)' }}>
                  {history.length} observations
                </span>
              </div>
              {history.length > 0 ? (
                <BtcChart history={history} />
              ) : (
                <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--v2-text-muted)', fontSize: 13 }}>
                  Collecting first data points…
                </div>
              )}
            </div>

            {/* Fear & Greed */}
            <div style={{
              background: 'var(--v2-bg-secondary)',
              border: '1px solid var(--v2-border)',
              borderRadius: 8, padding: '16px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
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
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--v2-font-data)', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--v2-bg-tertiary)' }}>
                      {['Time', 'BTC', '24h', 'ETH', '24h', 'Mkt Cap', 'Dom%', 'F&G', 'DXY', '10Y', 'Gold'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--v2-text-secondary)', fontWeight: 500, letterSpacing: '0.5px', fontSize: 10, textTransform: 'uppercase', borderBottom: '1px solid var(--v2-border)', whiteSpace: 'nowrap' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row, i) => {
                      const btcChg = Number(row.btc_change_24h);
                      const ethChg = Number(row.eth_change_24h);
                      return (
                        <tr key={row.id} style={{ borderBottom: i < history.length - 1 ? '1px solid var(--v2-border)' : 'none', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)', whiteSpace: 'nowrap' }}>
                            {timeAgo(row.observed_at)}
                          </td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-primary)' }}>{fmtUSD(row.btc_price)}</td>
                          <td style={{ padding: '7px 12px', color: btcChg >= 0 ? 'var(--v2-accent-green)' : 'var(--v2-accent-red)' }}>{fmtPct(row.btc_change_24h)}</td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-primary)' }}>{fmtUSD(row.eth_price)}</td>
                          <td style={{ padding: '7px 12px', color: ethChg >= 0 ? 'var(--v2-accent-green)' : 'var(--v2-accent-red)' }}>{fmtPct(row.eth_change_24h)}</td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)' }}>{fmtCap(row.total_market_cap)}</td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)' }}>{fmtNum(row.btc_dominance, 1)}</td>
                          <td style={{ padding: '7px 12px' }}>
                            <span style={{ color: row.fear_greed_value <= 25 ? 'var(--v2-accent-red)' : row.fear_greed_value >= 75 ? 'var(--v2-accent-cyan)' : row.fear_greed_value >= 55 ? 'var(--v2-accent-green)' : 'var(--v2-text-secondary)' }}>
                              {row.fear_greed_value ?? '—'}
                            </span>
                          </td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)' }}>{fmtNum(row.dxy, 2)}</td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)' }}>{row.treasury_10y != null ? fmtNum(row.treasury_10y, 2) + '%' : '—'}</td>
                          <td style={{ padding: '7px 12px', color: 'var(--v2-text-secondary)' }}>{fmtUSD(row.gold_price)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!latest && !history.length && (
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
