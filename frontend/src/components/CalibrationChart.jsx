import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const BAR_HEIGHT = 140;

export default function CalibrationChart() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  async function fetchCalibration() {
    try {
      const result = await api('/calibration');
      setData(result);
      setError(null);
    } catch (err) {
      console.error('Calibration fetch:', err);
      setError('Failed to load');
    }
  }

  useEffect(() => { fetchCalibration(); }, []);

  // Listen for WebSocket calibration updates
  useEffect(() => {
    function handleMessage(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'calibration_update') fetchCalibration();
      } catch {}
    }
    // Find existing WebSocket connections on the page
    const ws = window.__gridWs;
    if (ws) ws.addEventListener('message', handleMessage);
    return () => { if (ws) ws.removeEventListener('message', handleMessage); };
  }, []);

  if (error) return <div className="v2-cal-empty">{error}</div>;
  if (!data) return <div className="v2-cal-empty">Loading calibration...</div>;

  const { buckets, calibration_score, total_trades, qualified_buckets } = data;
  const hasBuckets = buckets && buckets.length > 0;
  const hasData = total_trades > 0;

  // Find max value for scaling bars
  const maxVal = hasData
    ? Math.max(100, ...buckets.map(b => parseFloat(b.actual_win_rate) || 0), ...buckets.map(b => parseFloat(b.predicted_avg) || 0))
    : 100;

  function barColor(bucket) {
    const actual = parseFloat(bucket.actual_win_rate) || 0;
    const predicted = parseFloat(bucket.predicted_avg) || 0;
    if (actual > predicted) return 'var(--v2-accent-green)';
    if (predicted - actual > 10) return 'var(--v2-accent-red)';
    return 'var(--v2-accent-cyan)';
  }

  // Score badge color
  let scoreColor = 'var(--v2-text-muted)';
  if (calibration_score !== null) {
    if (calibration_score >= 80) scoreColor = 'var(--v2-accent-green)';
    else if (calibration_score >= 60) scoreColor = 'var(--v2-accent-cyan)';
    else if (calibration_score >= 40) scoreColor = 'var(--v2-accent-amber)';
    else scoreColor = 'var(--v2-accent-red)';
  }

  return (
    <div className="v2-cal">
      <div className="v2-cal-header">
        <span className="v2-cal-title">Confidence Calibration</span>
        <div className="v2-cal-badge" style={{ borderColor: scoreColor, color: scoreColor }}>
          {calibration_score !== null ? Number(calibration_score).toFixed(0) : '--'}
        </div>
      </div>

      <div className="v2-cal-meta">
        <span>{total_trades} trades</span>
        <span className="v2-cal-sep">/</span>
        <span>{qualified_buckets} qualified buckets</span>
      </div>

      {!hasData ? (
        <div className="v2-cal-empty">No closed trades with confidence data yet</div>
      ) : (
        <>
          <div className="v2-cal-chart">
            {buckets.map((b) => {
              const predicted = parseFloat(b.predicted_avg) || 0;
              const actual = parseFloat(b.actual_win_rate) || 0;
              const samples = b.sample_size || 0;
              const predictedH = (predicted / maxVal) * BAR_HEIGHT;
              const actualH = (actual / maxVal) * BAR_HEIGHT;

              return (
                <div key={b.confidence_bracket} className="v2-cal-col" title={`${b.confidence_bucket}: predicted ${predicted.toFixed(1)}% / actual ${actual.toFixed(1)}% (${samples} trades)`}>
                  <div className="v2-cal-bars" style={{ height: BAR_HEIGHT }}>
                    {/* Predicted bar */}
                    <div
                      className="v2-cal-bar v2-cal-bar--predicted"
                      style={{ height: predictedH }}
                    />
                    {/* Actual bar */}
                    <div
                      className="v2-cal-bar v2-cal-bar--actual"
                      style={{
                        height: actualH,
                        background: barColor(b),
                        boxShadow: `0 0 6px ${barColor(b)}33`,
                      }}
                    />
                  </div>
                  <span className="v2-cal-label">{b.confidence_bucket || b.confidence_bracket}</span>
                  <span className="v2-cal-n">n={samples}</span>
                </div>
              );
            })}
          </div>

          <div className="v2-cal-legend">
            <span className="v2-cal-legend-item">
              <span className="v2-cal-swatch v2-cal-swatch--predicted" />
              Predicted
            </span>
            <span className="v2-cal-legend-item">
              <span className="v2-cal-swatch v2-cal-swatch--actual" />
              Actual
            </span>
          </div>
        </>
      )}

      <style>{`
        .v2-cal { display: flex; flex-direction: column; gap: var(--v2-space-sm); }
        .v2-cal-header { display: flex; justify-content: space-between; align-items: center; }
        .v2-cal-title { font-family: var(--v2-font-data); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; color: var(--v2-text-muted); }
        .v2-cal-badge { font-family: var(--v2-font-data); font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; padding: 2px 10px; border: 1px solid; border-radius: var(--v2-radius-full); min-width: 40px; text-align: center; }
        .v2-cal-meta { font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-text-muted); display: flex; gap: var(--v2-space-xs); }
        .v2-cal-sep { opacity: 0.3; }
        .v2-cal-empty { color: var(--v2-text-muted); font-family: var(--v2-font-body); font-size: 13px; padding: var(--v2-space-xl) 0; text-align: center; }

        .v2-cal-chart { display: flex; gap: 2px; align-items: flex-end; padding-top: var(--v2-space-sm); }
        .v2-cal-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; }
        .v2-cal-bars { display: flex; gap: 2px; align-items: flex-end; width: 100%; }
        .v2-cal-bar { flex: 1; border-radius: 2px 2px 0 0; min-height: 2px; transition: height 0.4s var(--v2-ease-out); }
        .v2-cal-bar--predicted { background: var(--v2-text-muted); opacity: 0.25; }
        .v2-cal-bar--actual { /* color set inline */ }
        .v2-cal-label { font-family: var(--v2-font-data); font-size: 9px; color: var(--v2-text-secondary); white-space: nowrap; }
        .v2-cal-n { font-family: var(--v2-font-data); font-size: 8px; color: var(--v2-text-muted); font-variant-numeric: tabular-nums; }

        .v2-cal-legend { display: flex; gap: var(--v2-space-md); justify-content: center; padding-top: var(--v2-space-xs); }
        .v2-cal-legend-item { display: flex; align-items: center; gap: 4px; font-family: var(--v2-font-data); font-size: 9px; color: var(--v2-text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
        .v2-cal-swatch { width: 10px; height: 10px; border-radius: 2px; }
        .v2-cal-swatch--predicted { background: var(--v2-text-muted); opacity: 0.25; }
        .v2-cal-swatch--actual { background: var(--v2-accent-cyan); }
      `}</style>
    </div>
  );
}
