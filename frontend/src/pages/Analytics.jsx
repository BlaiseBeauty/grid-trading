import { useEffect, useRef, useState } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';
import { api } from '../lib/api';
import { formatMoney, formatPct } from '../lib/format';
import { GlowCard, TickingNumber, ProgressRing } from '../components/ui';

export default function Analytics() {
  const [summary, setSummary] = useState(null);
  const [pnlData, setPnlData] = useState([]);
  const [pnlPeriod, setPnlPeriod] = useState('daily');
  const [byAgent, setByAgent] = useState([]);
  const [signalAccuracy, setSignalAccuracy] = useState([]);
  const [costData, setCostData] = useState([]);
  const [maxDrawdown, setMaxDrawdown] = useState(null);
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

  useEffect(() => {
    if (!equityRef.current || !drawdownRef.current) return;

    const chartOpts = {
      layout: { background: { color: 'transparent' }, textColor: '#55575e', fontFamily: "'JetBrains Mono', monospace", fontSize: 10 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      timeScale: { borderColor: 'rgba(255,255,255,0.07)', timeVisible: true },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.07)' },
      crosshair: { mode: 0 },
      handleScale: { mouseWheel: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
    };

    const eqChart = createChart(equityRef.current, chartOpts);
    const eqSeries = eqChart.addSeries(AreaSeries, {
      topColor: 'rgba(79, 195, 247, 0.20)', bottomColor: 'rgba(79, 195, 247, 0.01)',
      lineColor: '#4fc3f7', lineWidth: 2,
    });

    const ddChart = createChart(drawdownRef.current, chartOpts);
    const ddSeries = ddChart.addSeries(AreaSeries, {
      topColor: 'rgba(239, 83, 80, 0.01)', bottomColor: 'rgba(239, 83, 80, 0.15)',
      lineColor: '#ef5350', lineWidth: 2, invertFilledArea: true,
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
        const maxDD = Math.min(...drawdown.map(d => d.drawdown));
        setMaxDrawdown(maxDD);
      }
    });

    const eqObs = new ResizeObserver(e => { const { width, height } = e[0].contentRect; eqChart.applyOptions({ width, height }); });
    const ddObs = new ResizeObserver(e => { const { width, height } = e[0].contentRect; ddChart.applyOptions({ width, height }); });
    eqObs.observe(equityRef.current);
    ddObs.observe(drawdownRef.current);

    return () => { eqObs.disconnect(); ddObs.disconnect(); eqChart.remove(); ddChart.remove(); };
  }, []);

  const winRate = parseFloat(summary?.win_rate || 0);
  const totalPnl = parseFloat(summary?.total_pnl || 0);
  const totalCost = parseFloat(summary?.total_cost || 0);
  const totalTrades = summary?.total_trades || 0;
  const costPerTrade = totalTrades > 0 ? totalCost / totalTrades : 0;
  // Cumulative cost for sparkline
  const cumCosts = costData.slice(-14).reduce((acc, c) => {
    const prev = acc.length ? acc[acc.length - 1] : 0;
    acc.push(prev + parseFloat(c.daily_cost || 0));
    return acc;
  }, []);

  return (
    <div className="v2-analytics">
      <h1 className="v2-title v2-animate-in">ANALYTICS</h1>

      {/* KPI Strip */}
      {summary && (
        <div className="v2-kpi-strip">
          <GlowCard className="v2-kpi v2-animate-in v2-stagger-1">
            <div className="v2-kpi-label">Total Trades</div>
            <span className="v2-kpi-big">{summary.total_trades}</span>
          </GlowCard>
          <GlowCard className="v2-kpi v2-kpi--ring v2-animate-in v2-stagger-2">
            <div className="v2-kpi-label">Win Rate</div>
            <ProgressRing
              value={winRate}
              size={52}
              strokeWidth={3}
              color={winRate >= 50 ? 'var(--v2-accent-green)' : 'var(--v2-accent-amber)'}
            />
          </GlowCard>
          <GlowCard className="v2-kpi v2-animate-in v2-stagger-3" glowColor={totalPnl >= 0 ? 'green' : 'red'}>
            <div className="v2-kpi-label">Total P&L</div>
            <TickingNumber value={totalPnl} format="money" decimals={2} />
          </GlowCard>
          <GlowCard className="v2-kpi v2-animate-in v2-stagger-4">
            <div className="v2-kpi-label">Avg Return</div>
            <TickingNumber value={parseFloat(summary.avg_return || 0)} format="pct" decimals={2} />
          </GlowCard>
          <GlowCard className="v2-kpi v2-animate-in v2-stagger-5" glowColor="green">
            <div className="v2-kpi-label">Best Trade</div>
            <span className="v2-kpi-big v2-profit">{formatMoney(parseFloat(summary.best_trade || 0))}</span>
          </GlowCard>
          <GlowCard className="v2-kpi v2-animate-in v2-stagger-6" glowColor="red">
            <div className="v2-kpi-label">Worst Trade</div>
            <span className="v2-kpi-big v2-loss">{formatMoney(parseFloat(summary.worst_trade || 0))}</span>
          </GlowCard>
          <GlowCard className="v2-kpi v2-animate-in v2-stagger-7">
            <div className="v2-kpi-label">Max Drawdown</div>
            <span className="v2-kpi-big v2-loss">{maxDrawdown != null ? `${maxDrawdown.toFixed(2)}%` : '\u2014'}</span>
          </GlowCard>
          <GlowCard className="v2-kpi v2-animate-in v2-stagger-8" glowColor="magenta">
            <div className="v2-kpi-label">AI Cost</div>
            <TickingNumber value={totalCost} format="money" decimals={2} colorize={false} />
          </GlowCard>
        </div>
      )}

      {/* Charts */}
      <GlowCard className="v2-chart-card v2-animate-in v2-stagger-3">
        <div className="v2-section-title">Equity Curve</div>
        <div ref={equityRef} className="v2-chart-area" />
      </GlowCard>

      <GlowCard className="v2-chart-card v2-animate-in v2-stagger-4">
        <div className="v2-section-title">Drawdown</div>
        <div ref={drawdownRef} className="v2-chart-area" />
      </GlowCard>

      <div className="v2-grid-2">
        {/* P&L Breakdown */}
        <GlowCard className="v2-animate-in v2-stagger-5">
          <div className="v2-panel-row">
            <span className="v2-section-title" style={{ marginBottom: 0 }}>P&L Breakdown</span>
            <div className="v2-period-pills">
              {['daily', 'weekly', 'monthly'].map(p => (
                <button key={p} className={`v2-pill-sm ${pnlPeriod === p ? 'active' : ''}`} onClick={() => setPnlPeriod(p)}>
                  {p[0].toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {pnlData.length === 0 ? (
            <div className="v2-empty">No closed trades yet</div>
          ) : (
            <div className="v2-table">
              <div className="v2-tbl-header">
                <span className="v2-tbl-col" style={{ flex: 2 }}>Period</span>
                <span className="v2-tbl-col">Trades</span>
                <span className="v2-tbl-col">W/L</span>
                <span className="v2-tbl-col" style={{ flex: 2 }}>P&L</span>
                <span className="v2-tbl-col">Avg %</span>
              </div>
              {pnlData.slice(0, 20).map((row, i) => {
                const pnl = parseFloat(row.total_pnl);
                return (
                  <div key={i} className="v2-tbl-row">
                    <span className="v2-tbl-col v2-mono" style={{ flex: 2 }}>{new Date(row.period).toLocaleDateString()}</span>
                    <span className="v2-tbl-col v2-mono">{row.trade_count}</span>
                    <span className="v2-tbl-col"><span className="v2-profit">{row.wins}</span>/<span className="v2-loss">{row.losses}</span></span>
                    <span className={`v2-tbl-col v2-mono ${pnl >= 0 ? 'v2-profit' : 'v2-loss'}`} style={{ flex: 2 }}>{formatMoney(pnl)}</span>
                    <span className={`v2-tbl-col v2-mono ${parseFloat(row.avg_return_pct) >= 0 ? 'v2-profit' : 'v2-loss'}`}>{formatPct(parseFloat(row.avg_return_pct), 2)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </GlowCard>

        {/* Performance by Agent */}
        <GlowCard className="v2-animate-in v2-stagger-6">
          <div className="v2-section-title">Performance by Agent</div>
          {byAgent.length === 0 ? (
            <div className="v2-empty">No signal-linked trades yet</div>
          ) : byAgent.map((a, i) => (
            <div key={i} className="v2-agent-row">
              <span className="v2-agent-name">{a.agent_name}</span>
              <span className="v2-mono v2-muted">{a.trade_count}</span>
              <ProgressRing value={parseFloat(a.win_rate || 0)} size={28} strokeWidth={2.5}
                color={parseFloat(a.win_rate) >= 50 ? 'var(--v2-accent-green)' : 'var(--v2-accent-red)'} />
              <span className={`v2-mono ${parseFloat(a.total_pnl) >= 0 ? 'v2-profit' : 'v2-loss'}`}>
                {formatMoney(parseFloat(a.total_pnl))}
              </span>
            </div>
          ))}
        </GlowCard>

        {/* Signal Accuracy */}
        <GlowCard className="v2-animate-in v2-stagger-7">
          <div className="v2-section-title">Signal Accuracy</div>
          {signalAccuracy.length === 0 ? (
            <div className="v2-empty">Need more trades to calculate accuracy</div>
          ) : signalAccuracy.map((s, i) => (
            <div key={i} className="v2-acc-row">
              <span className="v2-acc-cat">{s.signal_category}</span>
              <span className="v2-acc-type">{s.signal_type}</span>
              <span className="v2-mono v2-muted" style={{ minWidth: 25 }}>{s.total_signals}</span>
              <div className="v2-acc-bar-track">
                <div className="v2-acc-bar-fill" style={{
                  width: `${s.accuracy_pct || 0}%`,
                  background: parseFloat(s.accuracy_pct) >= 50 ? 'var(--v2-accent-green)' : 'var(--v2-accent-red)',
                }} />
              </div>
              <span className={`v2-mono ${parseFloat(s.accuracy_pct) >= 50 ? 'v2-profit' : 'v2-loss'}`}>
                {s.accuracy_pct}%
              </span>
            </div>
          ))}
        </GlowCard>

        {/* AI Cost Analysis */}
        <GlowCard className="v2-animate-in v2-stagger-8" glowColor="magenta">
          <div className="v2-section-title">AI Cost Analysis</div>
          <div className="v2-cost-kpi-row">
            <div className="v2-cost-kpi">
              <span className="v2-cost-kpi-label">Cost/Trade</span>
              <span className="v2-cost-kpi-val">${costPerTrade.toFixed(3)}</span>
            </div>
            <div className="v2-cost-kpi">
              <span className="v2-cost-kpi-label">Total Cost</span>
              <span className="v2-cost-kpi-val">${totalCost.toFixed(2)}</span>
            </div>
          </div>
          {costData.length === 0 ? (
            <div className="v2-empty">No cost data yet</div>
          ) : costData.slice(-14).reverse().map((c, i) => (
            <div key={i} className="v2-cost-row">
              <span className="v2-cost-date">{new Date(c.date).toLocaleDateString()}</span>
              <span className="v2-mono v2-muted">{c.call_count} calls</span>
              <span className="v2-mono v2-muted">{(parseInt(c.total_tokens || 0) / 1000).toFixed(0)}k</span>
              <span className="v2-mono v2-cost-amt">${parseFloat(c.daily_cost).toFixed(2)}</span>
            </div>
          ))}
        </GlowCard>
      </div>

      <style>{`
        .v2-analytics { display: flex; flex-direction: column; gap: var(--v2-space-sm); }
        .v2-title { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 16px; letter-spacing: 6px; color: var(--v2-text-primary); padding: var(--v2-space-xs) 0; }

        .v2-kpi-strip { display: flex; gap: var(--v2-space-sm); overflow-x: auto; scrollbar-width: none; }
        .v2-kpi-strip::-webkit-scrollbar { display: none; }
        .v2-kpi { min-width: 130px; flex: 1; }
        .v2-kpi .v2-ticking-number { font-size: 18px; font-weight: 400; }
        .v2-kpi-label { font-family: var(--v2-font-data); font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--v2-text-muted); margin-bottom: var(--v2-space-xs); }
        .v2-kpi--ring { display: flex; flex-direction: column; align-items: flex-start; }
        .v2-kpi-big { font-family: var(--v2-font-data); font-size: 18px; font-weight: 400; color: var(--v2-text-primary); font-variant-numeric: tabular-nums; }
        .v2-profit { color: var(--v2-accent-green); }
        .v2-loss { color: var(--v2-accent-red); }
        .v2-muted { color: var(--v2-text-muted); }
        .v2-mono { font-family: var(--v2-font-data); font-variant-numeric: tabular-nums; }

        .v2-chart-card { overflow: hidden; }
        .v2-chart-area { width: 100%; height: 280px; }
        .v2-section-title { font-family: var(--v2-font-data); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; color: var(--v2-text-muted); margin-bottom: var(--v2-space-md); }

        .v2-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: var(--v2-space-sm); }

        .v2-panel-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--v2-space-md); }
        .v2-period-pills { display: flex; gap: 2px; }
        .v2-pill-sm { padding: 3px 8px; font-family: var(--v2-font-data); font-size: 9px; font-weight: 500; color: var(--v2-text-muted); background: var(--v2-bg-tertiary); border: 1px solid var(--v2-border); border-radius: var(--v2-radius-sm); cursor: pointer; transition: all var(--v2-duration-fast); }
        .v2-pill-sm.active { color: var(--v2-accent-cyan); background: rgba(0,229,255,0.08); border-color: rgba(0,229,255,0.2); }

        .v2-table { overflow-x: auto; }
        .v2-tbl-header, .v2-tbl-row { display: flex; gap: var(--v2-space-sm); align-items: center; padding: var(--v2-space-xs) 0; }
        .v2-tbl-header { font-family: var(--v2-font-data); font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--v2-text-muted); border-bottom: 1px solid var(--v2-border); }
        .v2-tbl-row { font-size: 12px; border-bottom: 1px solid var(--v2-border); }
        .v2-tbl-col { flex: 1; min-width: 0; }

        .v2-agent-row { display: flex; align-items: center; gap: var(--v2-space-md); padding: var(--v2-space-sm) 0; border-bottom: 1px solid var(--v2-border); font-size: 12px; }
        .v2-agent-name { font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-accent-magenta); text-transform: uppercase; min-width: 80px; flex: 1; }

        .v2-acc-row { display: flex; align-items: center; gap: var(--v2-space-sm); padding: var(--v2-space-xs) 0; border-bottom: 1px solid var(--v2-border); font-size: 12px; }
        .v2-acc-cat { font-family: var(--v2-font-data); font-size: 9px; color: var(--v2-accent-magenta); text-transform: uppercase; min-width: 60px; }
        .v2-acc-type { color: var(--v2-text-secondary); flex: 1; font-size: 11px; }
        .v2-acc-bar-track { width: 60px; height: 4px; background: var(--v2-border); border-radius: 2px; overflow: hidden; }
        .v2-acc-bar-fill { height: 100%; border-radius: 2px; transition: width var(--v2-duration-normal); }

        .v2-cost-kpi-row { display: flex; gap: var(--v2-space-md); margin-bottom: var(--v2-space-md); }
        .v2-cost-kpi { display: flex; flex-direction: column; gap: 2px; }
        .v2-cost-kpi-label { font-family: var(--v2-font-data); font-size: 9px; color: var(--v2-text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
        .v2-cost-kpi-val { font-family: var(--v2-font-data); font-size: 16px; font-weight: 400; color: var(--v2-accent-magenta); font-variant-numeric: tabular-nums; }
        .v2-cost-row { display: flex; align-items: center; gap: var(--v2-space-md); padding: var(--v2-space-xs) 0; border-bottom: 1px solid var(--v2-border); font-size: 12px; }
        .v2-cost-date { font-family: var(--v2-font-data); font-size: 11px; min-width: 80px; color: var(--v2-text-primary); }
        .v2-cost-amt { color: var(--v2-accent-magenta); }

        .v2-empty { color: var(--v2-text-muted); font-family: var(--v2-font-body); font-size: 13px; padding: var(--v2-space-xl) 0; text-align: center; }

        @media (max-width: 768px) {
          .v2-kpi-strip { flex-wrap: nowrap; }
          .v2-kpi { min-width: 120px; }
          .v2-grid-2 { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
