import { useEffect, useRef, useState } from 'react';
import { createChart, AreaSeries, LineSeries } from 'lightweight-charts';
import { api } from '../lib/api';
import { formatPct, formatNum, formatPrice } from '../lib/format';
import { GlowCard } from '../components/ui';
import { useDataStore } from '../stores/data';

const DEFAULT_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];

export default function Backtest() {
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [runDetail, setRunDetail] = useState(null);
  const [equityCurve, setEquityCurve] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [feedResult, setFeedResult] = useState(null);
  const [tradePage, setTradePage] = useState(0);
  const progress = useDataStore(s => s.backtestProgress);

  // Config form
  const [name, setName] = useState('');
  const [symbols, setSymbols] = useState([...DEFAULT_SYMBOLS]);
  const [timeframe, setTimeframe] = useState('4h');
  const [dateFrom, setDateFrom] = useState('2022-01-01');
  const [dateTo, setDateTo] = useState(new Date().toISOString().slice(0, 10));
  const [splitDate, setSplitDate] = useState('2024-01-01');

  const equityRef = useRef(null);

  // Load runs on mount
  useEffect(() => {
    fetchRuns();
  }, []);

  // Auto-select most recent run
  useEffect(() => {
    if (runs.length > 0 && !selectedRun) {
      selectRun(runs[0].id);
    }
  }, [runs]);

  // Draw equity chart when data changes
  useEffect(() => {
    if (!equityRef.current || !equityCurve?.curve?.length) return;

    const chartOpts = {
      layout: { background: { color: 'transparent' }, textColor: '#55575e', fontFamily: "'JetBrains Mono', monospace", fontSize: 10 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      timeScale: { borderColor: 'rgba(255,255,255,0.07)', timeVisible: true },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.07)' },
      crosshair: { mode: 0 },
      handleScale: { mouseWheel: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
    };

    const chart = createChart(equityRef.current, chartOpts);

    // Split curve into in-sample and out-of-sample segments
    const isSample = equityCurve.curve.filter(p => p.is_in_sample);
    const oosSample = equityCurve.curve.filter(p => !p.is_in_sample);

    // In-sample line (magenta/AI color)
    if (isSample.length > 0) {
      const isSeries = chart.addSeries(AreaSeries, {
        topColor: 'rgba(179,157,219,0.15)', bottomColor: 'rgba(179,157,219,0.01)',
        lineColor: '#b39ddb', lineWidth: 2,
      });
      isSeries.setData(isSample.map(p => ({
        time: Math.floor(new Date(p.timestamp).getTime() / 1000),
        value: p.equity,
      })));
    }

    // Out-of-sample line (cyan)
    if (oosSample.length > 0) {
      const oosSeries = chart.addSeries(AreaSeries, {
        topColor: 'rgba(79,195,247,0.15)', bottomColor: 'rgba(79,195,247,0.01)',
        lineColor: '#4fc3f7', lineWidth: 2,
      });
      oosSeries.setData(oosSample.map(p => ({
        time: Math.floor(new Date(p.timestamp).getTime() / 1000),
        value: p.equity,
      })));
    }

    chart.timeScale().fitContent();

    const obs = new ResizeObserver(e => {
      const { width, height } = e[0].contentRect;
      chart.applyOptions({ width, height });
    });
    obs.observe(equityRef.current);

    return () => { obs.disconnect(); chart.remove(); };
  }, [equityCurve]);

  async function fetchRuns() {
    try {
      const data = await api('/backtest/runs');
      setRuns(data.runs || []);
    } catch (err) { console.error('fetchRuns:', err); }
  }

  async function selectRun(id) {
    setSelectedRun(id);
    setTradePage(0);
    setFeedResult(null);
    try {
      const [detail, curve] = await Promise.all([
        api(`/backtest/runs/${id}`),
        api(`/backtest/runs/${id}/equity-curve`),
      ]);
      setRunDetail(detail);
      setEquityCurve(curve);
    } catch (err) { console.error('selectRun:', err); }
  }

  async function handleRun() {
    setRunning(true);
    try {
      const result = await api('/backtest/run', {
        method: 'POST',
        body: JSON.stringify({
          name: name || `Backtest ${new Date().toLocaleDateString()}`,
          symbols, timeframe,
          date_from: dateFrom, date_to: dateTo,
          in_sample_cutoff: splitDate,
        }),
      });
      // Poll for completion
      pollRun(result.run_id);
    } catch (err) {
      console.error('handleRun:', err);
      setRunning(false);
    }
  }

  function pollRun(runId) {
    const interval = setInterval(async () => {
      try {
        const data = await api(`/backtest/runs/${runId}`);
        if (data.run?.status === 'complete' || data.run?.status === 'failed') {
          clearInterval(interval);
          setRunning(false);
          fetchRuns();
          selectRun(runId);
        }
      } catch { /* ignore */ }
    }, 3000);
  }

  async function handleFeedLearnings() {
    if (!selectedRun) return;
    try {
      const result = await api(`/backtest/runs/${selectedRun}/feed-learnings`, {
        method: 'POST', body: '{}',
      });
      setFeedResult(result);
    } catch (err) { console.error('feedLearnings:', err); }
  }

  function toggleSymbol(sym) {
    setSymbols(prev => prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym]);
  }

  const detail = runDetail;
  const run = detail?.run;
  const trades = detail?.trades || [];
  const bd = detail?.breakdowns || {};
  const sc = detail?.sampleComparison;
  const pageSize = 20;
  const pagedTrades = trades.slice(tradePage * pageSize, (tradePage + 1) * pageSize);

  return (
    <div className="v2-backtest">
      <h1 className="v2-title v2-animate-in">BACKTEST</h1>

      {/* SECTION 1: Run Configuration */}
      <GlowCard className="v2-animate-in v2-stagger-1">
        <div className="bt-section-title">RUN CONFIGURATION</div>
        <div className="bt-config-grid">
          <div className="bt-field">
            <label className="bt-label">Run Name</label>
            <input
              className="bt-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Full 3-Symbol 4h"
            />
          </div>
          <div className="bt-field">
            <label className="bt-label">Symbols</label>
            <div className="bt-symbol-group">
              {DEFAULT_SYMBOLS.map(sym => (
                <button
                  key={sym}
                  className={`bt-symbol-btn ${symbols.includes(sym) ? 'active' : ''}`}
                  onClick={() => toggleSymbol(sym)}
                >{sym.replace('/USDT', '')}</button>
              ))}
            </div>
          </div>
          <div className="bt-field">
            <label className="bt-label">Timeframe</label>
            <select className="bt-input" value={timeframe} onChange={e => setTimeframe(e.target.value)}>
              <option value="1h">1h</option>
              <option value="4h">4h</option>
            </select>
          </div>
          <div className="bt-field">
            <label className="bt-label">Date From</label>
            <input className="bt-input" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div className="bt-field">
            <label className="bt-label">Date To</label>
            <input className="bt-input" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
          <div className="bt-field">
            <label className="bt-label">Walk-Forward Split</label>
            <input className="bt-input" type="date" value={splitDate} onChange={e => setSplitDate(e.target.value)} />
          </div>
        </div>
        <button
          className="bt-run-btn"
          onClick={handleRun}
          disabled={running || symbols.length === 0}
        >
          {running ? 'RUNNING...' : 'RUN BACKTEST'}
        </button>
        {/* Progress bar */}
        {(running && progress) && (
          <div className="bt-progress">
            <div className="bt-progress-bar">
              <div className="bt-progress-fill" style={{ width: `${progress.progress_pct || 0}%` }} />
            </div>
            <span className="bt-progress-text">
              {progress.progress_pct?.toFixed(0)}% &middot; {progress.trades_so_far || 0} trades &middot; {progress.current_date?.slice(0, 10) || ''}
            </span>
          </div>
        )}
      </GlowCard>

      {/* SECTION 2: Run History Table */}
      {runs.length > 0 && (
        <GlowCard className="v2-animate-in v2-stagger-2">
          <div className="bt-section-title">RUN HISTORY</div>
          <div className="bt-table">
            <div className="bt-tbl-header">
              <span className="bt-col" style={{ flex: 2 }}>Name</span>
              <span className="bt-col">Period</span>
              <span className="bt-col">Trades</span>
              <span className="bt-col">Win Rate</span>
              <span className="bt-col">Return</span>
              <span className="bt-col">Sharpe</span>
              <span className="bt-col">Max DD</span>
              <span className="bt-col">Status</span>
            </div>
            {runs.map(r => (
              <div
                key={r.id}
                className={`bt-tbl-row ${selectedRun === r.id ? 'active' : ''}`}
                onClick={() => selectRun(r.id)}
              >
                <span className="bt-col" style={{ flex: 2 }}>{r.name || `Run #${r.id}`}</span>
                <span className="bt-col bt-mono">{r.date_from?.slice(0, 10)} &rarr; {r.date_to?.slice(0, 10)}</span>
                <span className="bt-col bt-mono">{r.total_trades ?? '\u2014'}</span>
                <span className="bt-col bt-mono">{r.win_rate != null ? `${parseFloat(r.win_rate).toFixed(1)}%` : '\u2014'}</span>
                <span className={`bt-col bt-mono ${parseFloat(r.total_return) >= 0 ? 'profit' : 'loss'}`}>
                  {r.total_return != null ? `${parseFloat(r.total_return) >= 0 ? '+' : ''}${parseFloat(r.total_return).toFixed(2)}%` : '\u2014'}
                </span>
                <span className={`bt-col bt-mono ${parseFloat(r.sharpe_ratio) >= 1 ? 'profit' : parseFloat(r.sharpe_ratio) >= 0.5 ? 'warn' : 'loss'}`}>
                  {r.sharpe_ratio != null ? parseFloat(r.sharpe_ratio).toFixed(2) : '\u2014'}
                </span>
                <span className="bt-col bt-mono loss">
                  {r.max_drawdown != null ? `${parseFloat(r.max_drawdown).toFixed(2)}%` : '\u2014'}
                </span>
                <span className="bt-col">
                  <span className={`bt-status bt-status--${r.status}`}>{r.status}</span>
                </span>
              </div>
            ))}
          </div>
        </GlowCard>
      )}

      {/* SECTION 3: Results Dashboard */}
      {run && run.status === 'complete' && (
        <>
          {/* KPI Strip */}
          <div className="bt-kpi-strip v2-animate-in v2-stagger-3">
            <GlowCard className="bt-kpi">
              <div className="bt-kpi-label">Total Trades</div>
              <div className="bt-kpi-value">{run.total_trades}</div>
            </GlowCard>
            <GlowCard className="bt-kpi" glowColor={parseFloat(run.win_rate) > 50 ? 'green' : 'red'}>
              <div className="bt-kpi-label">Win Rate</div>
              <div className={`bt-kpi-value ${parseFloat(run.win_rate) > 50 ? 'profit' : 'loss'}`}>
                {parseFloat(run.win_rate).toFixed(1)}%
              </div>
            </GlowCard>
            <GlowCard className="bt-kpi" glowColor={parseFloat(run.total_return) >= 0 ? 'green' : 'red'}>
              <div className="bt-kpi-label">Total Return</div>
              <div className={`bt-kpi-value ${parseFloat(run.total_return) >= 0 ? 'profit' : 'loss'}`}>
                {parseFloat(run.total_return) >= 0 ? '+' : ''}{parseFloat(run.total_return).toFixed(2)}%
              </div>
            </GlowCard>
            <GlowCard className="bt-kpi" glowColor={parseFloat(run.sharpe_ratio) >= 1 ? 'green' : parseFloat(run.sharpe_ratio) >= 0.5 ? 'amber' : 'red'}>
              <div className="bt-kpi-label">Sharpe Ratio</div>
              <div className={`bt-kpi-value ${parseFloat(run.sharpe_ratio) >= 1 ? 'profit' : parseFloat(run.sharpe_ratio) >= 0.5 ? 'warn' : 'loss'}`}>
                {parseFloat(run.sharpe_ratio).toFixed(4)}
              </div>
            </GlowCard>
            <GlowCard className="bt-kpi" glowColor="red">
              <div className="bt-kpi-label">Max Drawdown</div>
              <div className="bt-kpi-value loss">{parseFloat(run.max_drawdown).toFixed(2)}%</div>
            </GlowCard>
          </div>

          {/* Two-column layout */}
          <div className="bt-results-grid">
            {/* LEFT: Equity Curve + Trade Log */}
            <div className="bt-results-left">
              <GlowCard>
                <div className="bt-section-title">EQUITY CURVE</div>
                <div className="bt-chart-legend">
                  <span className="bt-legend-dot" style={{ background: '#b39ddb' }} /> In-Sample
                  <span className="bt-legend-dot" style={{ background: '#4fc3f7', marginLeft: 16 }} /> Out-of-Sample
                </div>
                <div ref={equityRef} className="bt-chart-container" />
              </GlowCard>

              <GlowCard>
                <div className="bt-section-title">TRADE LOG</div>
                <div className="bt-table">
                  <div className="bt-tbl-header">
                    <span className="bt-col">Symbol</span>
                    <span className="bt-col">Side</span>
                    <span className="bt-col">Entry</span>
                    <span className="bt-col">Exit</span>
                    <span className="bt-col">P&L%</span>
                    <span className="bt-col">Held</span>
                    <span className="bt-col">Regime</span>
                    <span className="bt-col">Template</span>
                    <span className="bt-col">Sample</span>
                  </div>
                  {pagedTrades.map(t => (
                    <div key={t.id} className="bt-tbl-row">
                      <span className="bt-col bt-mono">{t.symbol?.replace('/USDT', '')}</span>
                      <span className={`bt-col ${t.side === 'long' ? 'profit' : 'loss'}`}>{t.side}</span>
                      <span className="bt-col bt-mono">{formatPrice(t.entry_price)}</span>
                      <span className="bt-col bt-mono">{formatPrice(t.exit_price)}</span>
                      <span className={`bt-col bt-mono ${parseFloat(t.pnl_pct) >= 0 ? 'profit' : 'loss'}`}>
                        {parseFloat(t.pnl_pct) >= 0 ? '+' : ''}{parseFloat(t.pnl_pct).toFixed(2)}%
                      </span>
                      <span className="bt-col bt-mono">{formatHeld(t.entry_time, t.exit_time)}</span>
                      <span className="bt-col">{t.regime?.replace('_', ' ')}</span>
                      <span className="bt-col" title={t.template_name}>{(t.template_name || '').slice(0, 18)}</span>
                      <span className="bt-col">
                        <span className={`bt-sample-badge ${t.is_in_sample ? 'is' : 'oos'}`}>
                          {t.is_in_sample ? 'IS' : 'OOS'}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
                {trades.length > pageSize && (
                  <div className="bt-pagination">
                    <button disabled={tradePage === 0} onClick={() => setTradePage(p => p - 1)}>&laquo; Prev</button>
                    <span className="bt-mono">{tradePage * pageSize + 1}&ndash;{Math.min((tradePage + 1) * pageSize, trades.length)} of {trades.length}</span>
                    <button disabled={(tradePage + 1) * pageSize >= trades.length} onClick={() => setTradePage(p => p + 1)}>Next &raquo;</button>
                  </div>
                )}
              </GlowCard>
            </div>

            {/* RIGHT: Performance breakdowns */}
            <div className="bt-results-right">
              {/* Performance by Regime */}
              <GlowCard>
                <div className="bt-section-title">PERFORMANCE BY REGIME</div>
                {bd.byRegime && Object.entries(bd.byRegime).map(([regime, data]) => (
                  <div key={regime} className="bt-breakdown-row">
                    <span className="bt-breakdown-label">{regime.replace('_', ' ')}</span>
                    <div className="bt-breakdown-bar-wrap">
                      <div
                        className={`bt-breakdown-bar ${data.win_rate >= 50 ? 'profit' : 'loss'}`}
                        style={{ width: `${Math.min(data.win_rate, 100)}%` }}
                      />
                    </div>
                    <span className="bt-mono bt-breakdown-stat">{data.trades} trades</span>
                    <span className={`bt-mono bt-breakdown-stat ${data.win_rate >= 50 ? 'profit' : 'loss'}`}>
                      {data.win_rate.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </GlowCard>

              {/* Performance by Template */}
              <GlowCard>
                <div className="bt-section-title">PERFORMANCE BY TEMPLATE</div>
                <div className="bt-table">
                  <div className="bt-tbl-header">
                    <span className="bt-col" style={{ flex: 2 }}>Template</span>
                    <span className="bt-col">Trades</span>
                    <span className="bt-col">Win Rate</span>
                    <span className="bt-col">Avg Return</span>
                    <span className="bt-col">Sharpe</span>
                  </div>
                  {bd.byTemplate && Object.entries(bd.byTemplate)
                    .sort(([, a], [, b]) => (b.sharpe || 0) - (a.sharpe || 0))
                    .map(([name, data]) => (
                      <div key={name} className="bt-tbl-row">
                        <span className="bt-col" style={{ flex: 2 }} title={name}>{name.slice(0, 25)}</span>
                        <span className="bt-col bt-mono">{data.trades}</span>
                        <span className={`bt-col bt-mono ${data.win_rate >= 50 ? 'profit' : 'loss'}`}>
                          {data.win_rate?.toFixed(1)}%
                        </span>
                        <span className={`bt-col bt-mono ${data.avg_return >= 0 ? 'profit' : 'loss'}`}>
                          {data.avg_return >= 0 ? '+' : ''}{data.avg_return?.toFixed(2)}%
                        </span>
                        <span className={`bt-col bt-mono ${(data.sharpe || 0) >= 1 ? 'profit' : (data.sharpe || 0) >= 0.5 ? 'warn' : 'loss'}`}>
                          {data.sharpe?.toFixed(2) ?? '\u2014'}
                        </span>
                      </div>
                    ))}
                </div>
              </GlowCard>

              {/* In-Sample vs Out-of-Sample Comparison */}
              {sc && (
                <GlowCard glowColor={sc.validation === 'VALIDATED' ? 'green' : sc.validation === 'OVERFITTED' ? 'red' : 'amber'}>
                  <div className="bt-section-title">IN-SAMPLE vs OUT-OF-SAMPLE</div>
                  <div className="bt-comparison">
                    <div className="bt-comp-col">
                      <div className="bt-comp-header" style={{ color: '#b39ddb' }}>IN-SAMPLE</div>
                      <div className="bt-comp-stat">{sc.in_sample.trades} trades</div>
                      <div className={`bt-comp-stat ${sc.in_sample.win_rate >= 50 ? 'profit' : 'loss'}`}>
                        {sc.in_sample.win_rate.toFixed(1)}% win rate
                      </div>
                      <div className={`bt-comp-stat ${sc.in_sample.avg_return >= 0 ? 'profit' : 'loss'}`}>
                        {sc.in_sample.avg_return >= 0 ? '+' : ''}{sc.in_sample.avg_return.toFixed(2)}% avg
                      </div>
                    </div>
                    <div className="bt-comp-col">
                      <div className="bt-comp-header" style={{ color: '#4fc3f7' }}>OUT-OF-SAMPLE</div>
                      <div className="bt-comp-stat">{sc.out_of_sample.trades} trades</div>
                      <div className={`bt-comp-stat ${sc.out_of_sample.win_rate >= 50 ? 'profit' : 'loss'}`}>
                        {sc.out_of_sample.win_rate.toFixed(1)}% win rate
                      </div>
                      <div className={`bt-comp-stat ${sc.out_of_sample.avg_return >= 0 ? 'profit' : 'loss'}`}>
                        {sc.out_of_sample.avg_return >= 0 ? '+' : ''}{sc.out_of_sample.avg_return.toFixed(2)}% avg
                      </div>
                    </div>
                  </div>
                  <div className="bt-validation-badge-wrap">
                    <span className={`bt-validation-badge bt-validation--${sc.validation?.toLowerCase()}`}>
                      {sc.validation}
                    </span>
                  </div>
                </GlowCard>
              )}

              {/* SECTION 4: Feed to Learning Loop */}
              <GlowCard glowColor="magenta">
                <div className="bt-section-title" style={{ color: 'var(--v2-accent-magenta)' }}>LEARNING INTEGRATION</div>
                <button className="bt-feed-btn" onClick={handleFeedLearnings}>
                  FEED TO LEARNING LOOP
                </button>
                {feedResult && (
                  <div className="bt-feed-result">
                    <span className="profit">{feedResult.learnings_stored} learnings stored</span>
                    {feedResult.anti_patterns_flagged > 0 && (
                      <span className="loss" style={{ marginLeft: 12 }}>{feedResult.anti_patterns_flagged} anti-patterns flagged</span>
                    )}
                  </div>
                )}
              </GlowCard>
            </div>
          </div>
        </>
      )}

      {run && run.status === 'failed' && (
        <GlowCard glowColor="red">
          <div className="bt-section-title" style={{ color: 'var(--v2-accent-red)' }}>RUN FAILED</div>
          <div className="bt-error-text">{run.error_text || 'Unknown error'}</div>
        </GlowCard>
      )}

      <style>{`
        .v2-backtest { display: flex; flex-direction: column; gap: var(--v2-space-sm); }

        .bt-section-title {
          font-family: var(--v2-font-data);
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          color: var(--v2-text-muted);
          margin-bottom: var(--v2-space-md);
        }

        /* Config form */
        .bt-config-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: var(--v2-space-md);
          margin-bottom: var(--v2-space-lg);
        }
        .bt-field { display: flex; flex-direction: column; gap: 4px; }
        .bt-label {
          font-family: var(--v2-font-data);
          font-size: 9px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--v2-text-muted);
        }
        .bt-input {
          background: var(--v2-bg-tertiary);
          border: 1px solid var(--v2-border);
          border-radius: var(--v2-radius-sm);
          padding: var(--v2-space-sm) var(--v2-space-md);
          color: var(--v2-text-primary);
          font-family: var(--v2-font-data);
          font-size: 12px;
          outline: none;
          transition: border-color var(--v2-duration-fast);
        }
        .bt-input:focus { border-color: var(--v2-accent-cyan); }
        .bt-symbol-group { display: flex; gap: 4px; }
        .bt-symbol-btn {
          padding: 4px 10px;
          border-radius: var(--v2-radius-full);
          font-family: var(--v2-font-data);
          font-size: 11px;
          font-weight: 600;
          color: var(--v2-text-secondary);
          background: var(--v2-bg-tertiary);
          border: 1px solid var(--v2-border);
          cursor: pointer;
          transition: all var(--v2-duration-fast);
        }
        .bt-symbol-btn.active {
          color: var(--v2-accent-cyan);
          border-color: var(--v2-accent-cyan);
          background: rgba(79,195,247,0.08);
        }
        .bt-run-btn {
          width: 100%;
          padding: var(--v2-space-md) var(--v2-space-lg);
          background: rgba(79,195,247,0.10);
          border: 1px solid var(--v2-accent-cyan);
          border-radius: var(--v2-radius-sm);
          color: var(--v2-accent-cyan);
          font-family: var(--v2-font-data);
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 2px;
          cursor: pointer;
          transition: all var(--v2-duration-fast);
        }
        .bt-run-btn:hover:not(:disabled) { background: rgba(79,195,247,0.18); }
        .bt-run-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        /* Progress */
        .bt-progress { margin-top: var(--v2-space-md); }
        .bt-progress-bar {
          height: 4px;
          background: var(--v2-bg-tertiary);
          border-radius: 2px;
          overflow: hidden;
        }
        .bt-progress-fill {
          height: 100%;
          background: var(--v2-accent-cyan);
          transition: width 500ms ease;
        }
        .bt-progress-text {
          font-family: var(--v2-font-data);
          font-size: 10px;
          color: var(--v2-text-muted);
          margin-top: 4px;
          display: block;
        }

        /* Tables */
        .bt-table { overflow-x: auto; }
        .bt-tbl-header {
          display: flex;
          border-bottom: 1px solid var(--v2-border);
          padding-bottom: var(--v2-space-sm);
          margin-bottom: var(--v2-space-xs);
        }
        .bt-tbl-header .bt-col {
          font-family: var(--v2-font-data);
          font-size: 9px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--v2-text-muted);
        }
        .bt-tbl-row {
          display: flex;
          align-items: center;
          padding: var(--v2-space-xs) 0;
          border-bottom: 1px solid rgba(255,255,255,0.03);
          cursor: pointer;
          transition: background var(--v2-duration-fast);
        }
        .bt-tbl-row:hover { background: var(--v2-bg-secondary); }
        .bt-tbl-row.active {
          background: rgba(79,195,247,0.05);
          border-left: 2px solid var(--v2-accent-cyan);
        }
        .bt-col {
          flex: 1;
          font-family: var(--v2-font-body);
          font-size: 11px;
          color: var(--v2-text-secondary);
          padding: 0 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .bt-mono {
          font-family: var(--v2-font-data);
          font-variant-numeric: tabular-nums;
        }
        .profit { color: var(--v2-accent-green) !important; }
        .loss { color: var(--v2-accent-red) !important; }
        .warn { color: var(--v2-accent-amber) !important; }

        /* Status badges */
        .bt-status {
          font-family: var(--v2-font-data);
          font-size: 9px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 2px 6px;
          border-radius: var(--v2-radius-sm);
        }
        .bt-status--complete { color: var(--v2-accent-green); background: rgba(102,187,106,0.1); }
        .bt-status--running { color: var(--v2-accent-cyan); background: rgba(79,195,247,0.1); }
        .bt-status--pending { color: var(--v2-accent-amber); background: rgba(255,167,38,0.1); }
        .bt-status--failed { color: var(--v2-accent-red); background: rgba(239,83,80,0.1); }

        .bt-sample-badge {
          font-family: var(--v2-font-data);
          font-size: 8px;
          font-weight: 700;
          letter-spacing: 0.5px;
          padding: 1px 5px;
          border-radius: var(--v2-radius-sm);
        }
        .bt-sample-badge.is { color: #b39ddb; background: rgba(179,157,219,0.12); }
        .bt-sample-badge.oos { color: #4fc3f7; background: rgba(79,195,247,0.12); }

        /* KPI strip */
        .bt-kpi-strip {
          display: flex;
          gap: var(--v2-space-sm);
          overflow-x: auto;
        }
        .bt-kpi { min-width: 140px; text-align: center; }
        .bt-kpi-label {
          font-family: var(--v2-font-data);
          font-size: 9px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--v2-text-muted);
          margin-bottom: 4px;
        }
        .bt-kpi-value {
          font-family: var(--v2-font-data);
          font-size: 22px;
          font-weight: 300;
          font-variant-numeric: tabular-nums;
          color: var(--v2-text-primary);
        }

        /* Results grid */
        .bt-results-grid {
          display: grid;
          grid-template-columns: 1.2fr 1fr;
          gap: var(--v2-space-sm);
        }
        @media (max-width: 1024px) {
          .bt-results-grid { grid-template-columns: 1fr; }
        }
        .bt-results-left, .bt-results-right {
          display: flex;
          flex-direction: column;
          gap: var(--v2-space-sm);
        }

        /* Equity chart */
        .bt-chart-container { height: 280px; }
        .bt-chart-legend {
          display: flex;
          align-items: center;
          gap: 6px;
          font-family: var(--v2-font-data);
          font-size: 9px;
          color: var(--v2-text-muted);
          margin-bottom: var(--v2-space-sm);
        }
        .bt-legend-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
        }

        /* Breakdown bars */
        .bt-breakdown-row {
          display: flex;
          align-items: center;
          gap: var(--v2-space-sm);
          margin-bottom: var(--v2-space-sm);
        }
        .bt-breakdown-label {
          font-family: var(--v2-font-data);
          font-size: 10px;
          color: var(--v2-text-secondary);
          text-transform: capitalize;
          width: 100px;
          flex-shrink: 0;
        }
        .bt-breakdown-bar-wrap {
          flex: 1;
          height: 6px;
          background: var(--v2-bg-tertiary);
          border-radius: var(--v2-radius-sm);
          overflow: hidden;
        }
        .bt-breakdown-bar {
          height: 100%;
          border-radius: var(--v2-radius-sm);
          transition: width 600ms ease;
        }
        .bt-breakdown-bar.profit { background: var(--v2-accent-green); }
        .bt-breakdown-bar.loss { background: var(--v2-accent-red); }
        .bt-breakdown-stat {
          font-size: 10px;
          width: 65px;
          text-align: right;
          flex-shrink: 0;
        }

        /* Comparison panel */
        .bt-comparison {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--v2-space-lg);
          margin-bottom: var(--v2-space-md);
        }
        .bt-comp-header {
          font-family: var(--v2-font-data);
          font-size: 9px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          margin-bottom: var(--v2-space-sm);
        }
        .bt-comp-stat {
          font-family: var(--v2-font-data);
          font-size: 12px;
          font-variant-numeric: tabular-nums;
          color: var(--v2-text-secondary);
          margin-bottom: 2px;
        }
        .bt-validation-badge-wrap { text-align: center; }
        .bt-validation-badge {
          font-family: var(--v2-font-data);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 2px;
          padding: 4px 16px;
          border-radius: var(--v2-radius-full);
        }
        .bt-validation--validated { color: var(--v2-accent-green); background: rgba(102,187,106,0.12); border: 1px solid rgba(102,187,106,0.3); }
        .bt-validation--overfitted { color: var(--v2-accent-red); background: rgba(239,83,80,0.12); border: 1px solid rgba(239,83,80,0.3); }
        .bt-validation--inconclusive { color: var(--v2-accent-amber); background: rgba(255,167,38,0.12); border: 1px solid rgba(255,167,38,0.3); }
        .bt-validation--insufficient_data { color: var(--v2-text-muted); background: var(--v2-bg-tertiary); border: 1px solid var(--v2-border); }

        /* Feed button */
        .bt-feed-btn {
          width: 100%;
          padding: var(--v2-space-md);
          background: rgba(179,157,219,0.10);
          border: 1px solid var(--v2-accent-magenta);
          border-radius: var(--v2-radius-sm);
          color: var(--v2-accent-magenta);
          font-family: var(--v2-font-data);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 1.5px;
          cursor: pointer;
          transition: background var(--v2-duration-fast);
        }
        .bt-feed-btn:hover { background: rgba(179,157,219,0.18); }
        .bt-feed-result {
          margin-top: var(--v2-space-sm);
          font-family: var(--v2-font-data);
          font-size: 11px;
        }

        /* Pagination */
        .bt-pagination {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: var(--v2-space-md);
          margin-top: var(--v2-space-md);
          font-family: var(--v2-font-data);
          font-size: 10px;
          color: var(--v2-text-muted);
        }
        .bt-pagination button {
          padding: 4px 10px;
          background: var(--v2-bg-tertiary);
          border: 1px solid var(--v2-border);
          border-radius: var(--v2-radius-sm);
          color: var(--v2-accent-cyan);
          font-family: var(--v2-font-data);
          font-size: 10px;
          cursor: pointer;
        }
        .bt-pagination button:disabled { opacity: 0.4; cursor: not-allowed; }

        .bt-error-text {
          font-family: var(--v2-font-data);
          font-size: 12px;
          color: var(--v2-accent-red);
          white-space: pre-wrap;
        }
      `}</style>
    </div>
  );
}

function formatHeld(entry, exit) {
  if (!entry || !exit) return '\u2014';
  const ms = new Date(exit) - new Date(entry);
  const hrs = Math.floor(ms / 3600000);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}
