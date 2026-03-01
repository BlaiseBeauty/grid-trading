import { useEffect, useRef, useState } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';
import { api } from '../lib/api';
import { formatMoney, formatPct } from '../lib/format';

export default function Analytics() {
  const [summary, setSummary] = useState(null);
  const [pnlData, setPnlData] = useState([]);
  const [pnlPeriod, setPnlPeriod] = useState('daily');
  const [byAgent, setByAgent] = useState([]);
  const [signalAccuracy, setSignalAccuracy] = useState([]);
  const [costData, setCostData] = useState([]);
  const equityRef = useRef(null);
  const drawdownRef = useRef(null);

  useEffect(() => {
    api('/analytics/summary').then(setSummary).catch(console.error);
    api('/analytics/by-agent').then(setByAgent).catch(console.error);
    api('/analytics/signal-accuracy').then(setSignalAccuracy).catch(console.error);
    api('/analytics/costs-over-time').then(setCostData).catch(console.error);
  }, []);

  useEffect(() => {
    api(`/analytics/pnl?period=${pnlPeriod}`).then(setPnlData).catch(console.error);
  }, [pnlPeriod]);

  // Equity + Drawdown charts
  useEffect(() => {
    if (!equityRef.current || !drawdownRef.current) return;

    const chartOpts = {
      layout: { background: { color: '#0d0f15' }, textColor: '#6e7590', fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
      crosshair: { mode: 0 },
      handleScale: { mouseWheel: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
    };

    const eqChart = createChart(equityRef.current, chartOpts);
    const eqSeries = eqChart.addSeries(AreaSeries,{
      topColor: 'rgba(0, 229, 255, 0.3)', bottomColor: 'rgba(0, 229, 255, 0.02)',
      lineColor: '#00e5ff', lineWidth: 2,
    });

    const ddChart = createChart(drawdownRef.current, chartOpts);
    const ddSeries = ddChart.addSeries(AreaSeries,{
      topColor: 'rgba(255, 45, 85, 0.02)', bottomColor: 'rgba(255, 45, 85, 0.2)',
      lineColor: '#ff2d55', lineWidth: 2, invertFilledArea: true,
    });

    Promise.all([
      api('/system/equity'),
      api('/analytics/drawdown'),
    ]).then(([equity, drawdown]) => {
      if (equity?.length) {
        eqSeries.setData(equity.map(s => ({
          time: Math.floor(new Date(s.created_at).getTime() / 1000),
          value: parseFloat(s.total_value),
        })));
        eqChart.timeScale().fitContent();
      }
      if (drawdown?.length) {
        ddSeries.setData(drawdown.map(s => ({
          time: Math.floor(new Date(s.time).getTime() / 1000),
          value: s.drawdown,
        })));
        ddChart.timeScale().fitContent();
      }
    });

    const eqObs = new ResizeObserver(e => { const { width, height } = e[0].contentRect; eqChart.applyOptions({ width, height }); });
    const ddObs = new ResizeObserver(e => { const { width, height } = e[0].contentRect; ddChart.applyOptions({ width, height }); });
    eqObs.observe(equityRef.current);
    ddObs.observe(drawdownRef.current);

    return () => { eqObs.disconnect(); ddObs.disconnect(); eqChart.remove(); ddChart.remove(); };
  }, []);

  return (
    <div className="analytics-page">
      <h1 className="page-title">ANALYTICS</h1>

      {/* Summary KPIs */}
      {summary && (
        <div className="analytics-kpis">
          <KPI label="Total Trades" value={summary.total_trades} />
          <KPI label="Win Rate" value={formatPct(parseFloat(summary.win_rate || 0), 1)} />
          <KPI label="Total P&L" value={formatMoney(parseFloat(summary.total_pnl || 0))} />
          <KPI label="Avg Return" value={formatPct(parseFloat(summary.avg_return || 0), 2)} />
          <KPI label="Best Trade" value={formatMoney(parseFloat(summary.best_trade || 0))} />
          <KPI label="Worst Trade" value={formatMoney(parseFloat(summary.worst_trade || 0))} />
          <KPI label="Avg Hold" value={`${parseFloat(summary.avg_hold_hours || 0).toFixed(1)}h`} />
          <KPI label="Win Streak" value={summary.max_win_streak || 0} />
          <KPI label="Loss Streak" value={summary.max_loss_streak || 0} />
          <KPI label="AI Cost" value={`$${parseFloat(summary.total_cost || 0).toFixed(2)}`} />
        </div>
      )}

      {/* Equity Curve */}
      <div className="panel chart-panel">
        <div className="chart-section-header"><span className="panel-title">Equity Curve</span></div>
        <div ref={equityRef} className="analytics-chart" />
      </div>

      {/* Drawdown */}
      <div className="panel chart-panel">
        <div className="chart-section-header"><span className="panel-title">Drawdown</span></div>
        <div ref={drawdownRef} className="analytics-chart" />
      </div>

      <div className="analytics-grid">
        {/* P&L Breakdown */}
        <div className="panel">
          <div className="panel-title-row">
            <span className="panel-title">P&L Breakdown</span>
            <div className="period-selector">
              {['daily', 'weekly', 'monthly'].map(p => (
                <button key={p} className={`chart-btn ${pnlPeriod === p ? 'active' : ''}`} onClick={() => setPnlPeriod(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
          {pnlData.length === 0 ? (
            <div className="empty-state">No closed trades yet</div>
          ) : (
            <div className="pnl-table">
              <div className="pnl-header">
                <span className="pnl-col pnl-period">Period</span>
                <span className="pnl-col pnl-trades">Trades</span>
                <span className="pnl-col pnl-wr">W/L</span>
                <span className="pnl-col pnl-total">P&L</span>
                <span className="pnl-col pnl-avg">Avg %</span>
              </div>
              {pnlData.slice(0, 20).map((row, i) => {
                const pnl = parseFloat(row.total_pnl);
                return (
                  <div key={i} className="pnl-row">
                    <span className="pnl-col pnl-period">{new Date(row.period).toLocaleDateString()}</span>
                    <span className="pnl-col pnl-trades num">{row.trade_count}</span>
                    <span className="pnl-col pnl-wr">
                      <span className="profit">{row.wins}</span>/<span className="loss">{row.losses}</span>
                    </span>
                    <span className={`pnl-col pnl-total ${pnl >= 0 ? 'profit' : 'loss'}`}>
                      {formatMoney(pnl)}
                    </span>
                    <span className={`pnl-col pnl-avg num ${parseFloat(row.avg_return_pct) >= 0 ? 'profit' : 'loss'}`}>
                      {formatPct(parseFloat(row.avg_return_pct), 2)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Performance by Agent */}
        <div className="panel">
          <div className="panel-title">Performance by Agent</div>
          {byAgent.length === 0 ? (
            <div className="empty-state">No signal-linked trades yet</div>
          ) : (
            <div className="agent-perf-table">
              {byAgent.map((a, i) => (
                <div key={i} className="agent-perf-row">
                  <span className="agent-perf-name">{a.agent_name}</span>
                  <span className="num agent-perf-trades">{a.trade_count}</span>
                  <span className={`num ${parseFloat(a.win_rate) >= 50 ? 'profit' : 'loss'}`}>
                    {a.win_rate}%
                  </span>
                  <span className={`num ${parseFloat(a.total_pnl) >= 0 ? 'profit' : 'loss'}`}>
                    {formatMoney(parseFloat(a.total_pnl))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Signal Accuracy */}
        <div className="panel">
          <div className="panel-title">Signal Accuracy</div>
          {signalAccuracy.length === 0 ? (
            <div className="empty-state">Need more trades to calculate accuracy</div>
          ) : (
            <div className="accuracy-table">
              {signalAccuracy.map((s, i) => (
                <div key={i} className="accuracy-row">
                  <span className="accuracy-category">{s.signal_category}</span>
                  <span className="accuracy-type">{s.signal_type}</span>
                  <span className="num accuracy-count">{s.total_signals}</span>
                  <div className="accuracy-bar-container">
                    <div className="accuracy-bar" style={{
                      width: `${s.accuracy_pct || 0}%`,
                      background: parseFloat(s.accuracy_pct) >= 50 ? 'var(--green)' : 'var(--red)',
                    }} />
                  </div>
                  <span className={`num ${parseFloat(s.accuracy_pct) >= 50 ? 'profit' : 'loss'}`}>
                    {s.accuracy_pct}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cost Trend */}
        <div className="panel">
          <div className="panel-title">AI Cost Trend</div>
          {costData.length === 0 ? (
            <div className="empty-state">No cost data yet</div>
          ) : (
            <div className="cost-table">
              {costData.slice(-14).reverse().map((c, i) => (
                <div key={i} className="cost-row">
                  <span className="cost-date">{new Date(c.date).toLocaleDateString()}</span>
                  <span className="num cost-calls">{c.call_count} calls</span>
                  <span className="num cost-tokens">{(parseInt(c.total_tokens || 0) / 1000).toFixed(0)}k tok</span>
                  <span className="num" style={{ color: 'var(--ai)' }}>${parseFloat(c.daily_cost).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <style>{`
        .analytics-page { display: flex; flex-direction: column; gap: var(--space-lg); }
        .page-title {
          font-family: 'Syne', sans-serif; font-weight: 800; font-size: 18px;
          letter-spacing: 6px; color: var(--t2);
        }
        .analytics-kpis {
          display: flex; gap: var(--panel-gap); overflow-x: auto;
          padding-bottom: var(--space-xs); flex-wrap: wrap;
        }
        .kpi { background: var(--surface); border: 1px solid var(--border-1); border-radius: var(--radius-md); padding: var(--space-sm) var(--space-md); min-width: 120px; }
        .kpi-lbl { font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--t4); margin-bottom: 2px; }
        .kpi-val { font-family: 'IBM Plex Mono', monospace; font-size: 16px; font-weight: 300; font-variant-numeric: tabular-nums; }
        .chart-panel { padding: 0; overflow: hidden; }
        .chart-section-header { padding: var(--space-md) var(--panel-padding); border-bottom: 1px solid var(--border-0); }
        .chart-section-header .panel-title { margin-bottom: 0; }
        .analytics-chart { width: 100%; height: 280px; }
        .analytics-grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
          gap: var(--panel-gap);
        }
        .panel-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-md); }
        .panel-title-row .panel-title { margin-bottom: 0; }
        .period-selector { display: flex; gap: 1px; }
        .chart-btn {
          padding: 3px 8px; font-family: 'IBM Plex Mono', monospace; font-size: 9px;
          font-weight: 500; color: var(--t3); background: var(--elevated);
          border: 1px solid var(--border-0); transition: all var(--transition-fast); cursor: pointer;
        }
        .chart-btn:first-child { border-radius: var(--radius-sm) 0 0 var(--radius-sm); }
        .chart-btn:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
        .chart-btn.active { color: var(--cyan); background: rgba(0,229,255,0.08); border-color: rgba(0,229,255,0.2); }
        .empty-state { color: var(--t4); font-size: 13px; padding: var(--space-xl); text-align: center; }
        .pnl-header, .pnl-row {
          display: grid; grid-template-columns: 100px 60px 60px 100px 70px;
          gap: var(--space-sm); align-items: center; padding: var(--space-xs) 0;
        }
        .pnl-header { font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--t4); border-bottom: 1px solid var(--border-1); }
        .pnl-row { font-size: 12px; border-bottom: 1px solid var(--border-0); }
        .pnl-period { font-family: 'IBM Plex Mono', monospace; font-size: 11px; }
        .agent-perf-row {
          display: flex; align-items: center; gap: var(--space-md);
          padding: var(--space-sm) 0; border-bottom: 1px solid var(--border-0); font-size: 12px;
        }
        .agent-perf-name { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: var(--ai); text-transform: uppercase; min-width: 80px; }
        .agent-perf-trades { color: var(--t3); min-width: 30px; }
        .accuracy-row {
          display: flex; align-items: center; gap: var(--space-sm);
          padding: var(--space-xs) 0; border-bottom: 1px solid var(--border-0); font-size: 12px;
        }
        .accuracy-category { font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: var(--ai); text-transform: uppercase; min-width: 60px; }
        .accuracy-type { color: var(--t2); flex: 1; font-size: 11px; }
        .accuracy-count { color: var(--t4); min-width: 25px; font-size: 10px; }
        .accuracy-bar-container { width: 60px; height: 4px; background: var(--border-0); border-radius: 2px; overflow: hidden; }
        .accuracy-bar { height: 100%; border-radius: 2px; transition: width 0.3s; }
        .cost-row {
          display: flex; align-items: center; gap: var(--space-md);
          padding: var(--space-xs) 0; border-bottom: 1px solid var(--border-0); font-size: 12px;
        }
        .cost-date { font-family: 'IBM Plex Mono', monospace; font-size: 11px; min-width: 80px; }
        .cost-calls { color: var(--t3); min-width: 60px; }
        .cost-tokens { color: var(--t4); min-width: 60px; }
      `}</style>
    </div>
  );
}

function KPI({ label, value }) {
  return (
    <div className="kpi">
      <div className="kpi-lbl">{label}</div>
      <div className="kpi-val">{value}</div>
    </div>
  );
}
