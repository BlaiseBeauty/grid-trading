import { useEffect, useState } from 'react';
import { useDataStore } from '../stores/data';
import { api } from '../lib/api';
import { formatMoney, formatPct, formatPrice, formatDuration, timeAgo } from '../lib/format';
import {
  GlowCard, TickingNumber, ProgressRing, SignalBadge, RangeBar, StatusPulse,
} from '../components/ui';
import TradeDetail from '../components/TradeDetail';

export default function Trades() {
  const fetchTrades = useDataStore(s => s.fetchTrades);
  const fetchPortfolio = useDataStore(s => s.fetchPortfolio);
  const trades = useDataStore(s => s.trades);
  const openTrades = useDataStore(s => s.openTrades);
  const tradeStats = useDataStore(s => s.tradeStats);
  const prices = useDataStore(s => s.prices);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(null);
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [tradeSignals, setTradeSignals] = useState({});

  useEffect(() => { fetchTrades(); fetchPortfolio(); }, []);

  async function loadSignals(tradeId) {
    if (tradeSignals[tradeId]) return;
    try {
      const sigs = await api(`/trades/${tradeId}/signals`);
      setTradeSignals(prev => ({ ...prev, [tradeId]: sigs }));
    } catch {}
  }

  function toggleExpand(trade) {
    if (expanded === trade.id) { setExpanded(null); return; }
    setExpanded(trade.id);
    loadSignals(trade.id);
  }

  const filtered = filter === 'all' ? trades
    : filter === 'open' ? openTrades
    : trades.filter(t => t.status === filter);

  const winRate = parseFloat(tradeStats?.win_rate || 0);
  const totalPnl = parseFloat(tradeStats?.total_pnl || 0);

  return (
    <div className="v2-trades">
      {/* Header */}
      <div className="v2-header v2-animate-in">
        <h1 className="v2-title">TRADES</h1>
        <div className="v2-filter-pills">
          {['all', 'open', 'closed'].map(f => (
            <button
              key={f}
              className={`v2-pill ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >{f}</button>
          ))}
        </div>
      </div>

      {/* KPI Strip */}
      {tradeStats && (
        <div className="v2-kpi-strip">
          <GlowCard className="v2-kpi v2-animate-in v2-stagger-1">
            <div className="v2-kpi-label">Total Trades</div>
            <TickingNumber value={tradeStats.total_closed || 0} format="number" decimals={0} colorize={false} />
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
            <TickingNumber value={parseFloat(tradeStats.avg_return_pct || 0)} format="pct" decimals={2} />
          </GlowCard>
          <GlowCard className="v2-kpi v2-animate-in v2-stagger-5" glowColor="cyan">
            <div className="v2-kpi-label">Open</div>
            <div className="v2-kpi-positions">
              <TickingNumber value={tradeStats.total_open || 0} format="number" decimals={0} colorize={false} />
              <div className="v2-kpi-dots">
                {(openTrades || []).slice(0, 6).map((_, i) => (
                  <StatusPulse key={i} status="active" size={5} />
                ))}
              </div>
            </div>
          </GlowCard>
        </div>
      )}

      {/* Trade Cards */}
      <div className="v2-trade-list">
        {filtered.length === 0 && (
          <GlowCard className="v2-animate-in v2-stagger-6">
            <div className="v2-empty">No trades to display</div>
          </GlowCard>
        )}
        {filtered.map((t, i) => {
          const entry = parseFloat(t.actual_fill_price || t.entry_price);
          const qty = parseFloat(t.quantity);
          const dashSymbol = t.symbol.replace('/', '-');
          const curPrice = prices[dashSymbol]?.price;
          const isOpen = t.status === 'open';
          const unrealisedPnl = (isOpen && curPrice)
            ? (t.side === 'buy' ? (curPrice - entry) * qty : (entry - curPrice) * qty)
            : null;
          const unrealisedPct = unrealisedPnl != null ? (unrealisedPnl / (entry * qty)) * 100 : null;
          const pnl = t.pnl_realised != null ? parseFloat(t.pnl_realised) : unrealisedPnl;
          const pnlPct = t.pnl_pct != null ? parseFloat(t.pnl_pct) : unrealisedPct;
          const sl = parseFloat(t.sl_price) || 0;
          const tp = parseFloat(t.tp_price) || 0;
          const isExpanded = expanded === t.id;
          const slippage = t.actual_fill_price && t.entry_price
            ? ((parseFloat(t.actual_fill_price) - parseFloat(t.entry_price)) / parseFloat(t.entry_price) * 100)
            : null;
          const sigs = tradeSignals[t.id] || [];

          return (
            <GlowCard
              key={t.id || i}
              className={`v2-trade-card v2-animate-in v2-stagger-${Math.min(i + 1, 8)}`}
              glowColor={pnl > 0 ? 'green' : pnl < 0 ? 'red' : 'cyan'}
              onClick={() => toggleExpand(t)}
            >
              <div className="v2-trade-compact">
                <div className="v2-trade-left">
                  <span className="v2-trade-symbol">{t.symbol}</span>
                  <SignalBadge direction={t.side === 'buy' ? 'long' : 'short'} />
                  {t.confidence && <span className="v2-trade-conf">{t.confidence}%</span>}
                </div>
                <div className="v2-trade-prices">
                  <div className="v2-trade-col">
                    <span className="v2-trade-lbl">Entry</span>
                    <span className="v2-trade-val">{formatPrice(entry)}</span>
                  </div>
                  <div className="v2-trade-col">
                    <span className="v2-trade-lbl">{isOpen ? 'Current' : 'Exit'}</span>
                    {isOpen && curPrice
                      ? <TickingNumber value={curPrice} format="money" colorize={false} />
                      : <span className="v2-trade-val">{t.exit_price ? formatPrice(t.exit_price) : '\u2014'}</span>
                    }
                  </div>
                  <div className="v2-trade-col">
                    <span className="v2-trade-lbl">P&L</span>
                    {isOpen && unrealisedPnl != null
                      ? <TickingNumber value={unrealisedPnl} format="money" />
                      : pnl != null
                        ? <span className={`v2-trade-val ${pnl >= 0 ? 'v2-profit' : 'v2-loss'}`}>{formatMoney(pnl)}</span>
                        : <span className="v2-trade-val v2-muted">\u2014</span>
                    }
                  </div>
                  <div className="v2-trade-col">
                    <span className="v2-trade-lbl">Return</span>
                    {isOpen && unrealisedPct != null
                      ? <TickingNumber value={unrealisedPct} format="pct" />
                      : pnlPct != null
                        ? <span className={`v2-trade-val ${pnlPct >= 0 ? 'v2-profit' : 'v2-loss'}`}>{formatPct(pnlPct, 2)}</span>
                        : <span className="v2-trade-val v2-muted">\u2014</span>
                    }
                  </div>
                </div>
                <div className="v2-trade-right">
                  <span className={`v2-status-tag ${isOpen ? 'v2-status--open' : pnl >= 0 ? 'v2-status--win' : 'v2-status--loss'}`}>
                    {t.status}
                  </span>
                  <span className="v2-trade-time">{timeAgo(t.closed_at || t.opened_at || t.created_at)}</span>
                  <span className="v2-trade-duration">⏱ {formatDuration(t.opened_at, t.closed_at)} {t.closed_at ? 'held' : 'open'}</span>
                </div>
              </div>

              {isExpanded && (
                <div className="v2-trade-detail" onClick={e => e.stopPropagation()}>
                  <div className="v2-detail-grid">
                    <div className="v2-detail-section">
                      <div className="v2-detail-title">Entry / Exit Details</div>
                      <div className="v2-detail-row">
                        <span>Intended Entry</span>
                        <span className="v2-detail-num">{formatPrice(t.entry_price)}</span>
                      </div>
                      {t.actual_fill_price && (
                        <div className="v2-detail-row">
                          <span>Actual Fill</span>
                          <span className="v2-detail-num">{formatPrice(t.actual_fill_price)}</span>
                        </div>
                      )}
                      {slippage != null && (
                        <div className="v2-detail-row">
                          <span>Slippage</span>
                          <span className={`v2-detail-num ${Math.abs(slippage) > 0.1 ? 'v2-loss' : ''}`}>
                            {slippage > 0 ? '+' : ''}{slippage.toFixed(3)}%
                          </span>
                        </div>
                      )}
                      {t.exit_price && (
                        <div className="v2-detail-row">
                          <span>Exit Price</span>
                          <span className="v2-detail-num">{formatPrice(t.exit_price)}</span>
                        </div>
                      )}
                      <div className="v2-detail-row">
                        <span>Quantity</span>
                        <span className="v2-detail-num">{qty}</span>
                      </div>
                    </div>

                    {(sl > 0 || tp > 0) && (
                      <div className="v2-detail-section">
                        <div className="v2-detail-title">TP / SL Levels</div>
                        {sl > 0 && <div className="v2-detail-row"><span>Stop Loss</span><span className="v2-detail-num v2-loss">{formatPrice(sl)}</span></div>}
                        {tp > 0 && <div className="v2-detail-row"><span>Take Profit</span><span className="v2-detail-num v2-profit">{formatPrice(tp)}</span></div>}
                        {sl > 0 && tp > 0 && (curPrice || t.exit_price) && (
                          <div style={{ marginTop: 'var(--v2-space-sm)' }}>
                            <RangeBar current={curPrice || parseFloat(t.exit_price)} low={Math.min(sl, tp)} high={Math.max(sl, tp)} side={t.side} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {sigs.length > 0 && (
                    <div className="v2-detail-section" style={{ marginTop: 'var(--v2-space-md)' }}>
                      <div className="v2-detail-title">Contributing Signals <span className="v2-count">{sigs.length}</span></div>
                      <div className="v2-signal-list">
                        {sigs.map((s, j) => (
                          <div key={j} className="v2-signal-row">
                            <span className="v2-signal-agent">{s.agent_name}</span>
                            <span className="v2-signal-type">{s.signal_type}</span>
                            <SignalBadge direction={s.direction} />
                            <span className="v2-signal-str">{s.strength}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {t.reasoning && (
                    <div className="v2-detail-section" style={{ marginTop: 'var(--v2-space-md)' }}>
                      <div className="v2-detail-title">Reasoning</div>
                      <p className="v2-reasoning">{t.reasoning}</p>
                    </div>
                  )}

                  <button className="v2-btn v2-btn--ghost" style={{ marginTop: 'var(--v2-space-md)' }} onClick={() => setSelectedTrade(t)}>
                    Full Details
                  </button>
                </div>
              )}
            </GlowCard>
          );
        })}
      </div>

      <TradeDetail
        trade={selectedTrade}
        open={!!selectedTrade}
        onClose={() => setSelectedTrade(null)}
      />

      <style>{`
        .v2-trades { display: flex; flex-direction: column; gap: var(--v2-space-sm); }

        .v2-header { display: flex; justify-content: space-between; align-items: center; padding: var(--v2-space-xs) 0; }
        .v2-title { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 16px; letter-spacing: 6px; color: var(--v2-text-primary); }

        .v2-filter-pills { display: flex; gap: var(--v2-space-xs); }
        .v2-pill {
          padding: 6px 16px;
          font-family: var(--v2-font-data); font-size: 10px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 1px;
          color: var(--v2-text-muted);
          border: 1px solid var(--v2-border); border-radius: var(--v2-radius-full);
          background: transparent; cursor: pointer;
          transition: all var(--v2-duration-fast) var(--v2-ease-out);
        }
        .v2-pill:hover { border-color: var(--v2-border-hover); color: var(--v2-text-secondary); }
        .v2-pill.active {
          color: var(--v2-accent-cyan); border-color: var(--v2-accent-cyan);
          background: rgba(0,229,255,0.06);
          box-shadow: 0 0 12px rgba(0,229,255,0.15);
        }

        .v2-kpi-strip { display: flex; gap: var(--v2-space-sm); overflow-x: auto; scrollbar-width: none; }
        .v2-kpi-strip::-webkit-scrollbar { display: none; }
        .v2-kpi { min-width: 140px; flex: 1; }
        .v2-kpi .v2-ticking-number { font-size: 18px; font-weight: 400; }
        .v2-kpi-label {
          font-family: var(--v2-font-data); font-size: 9px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1px;
          color: var(--v2-text-muted); margin-bottom: var(--v2-space-xs);
        }
        .v2-kpi--ring { display: flex; flex-direction: column; align-items: flex-start; }
        .v2-kpi-positions { display: flex; align-items: center; gap: var(--v2-space-md); }
        .v2-kpi-big-num {
          font-family: var(--v2-font-data); font-size: 20px; font-weight: 400;
          color: var(--v2-text-primary); font-variant-numeric: tabular-nums;
        }
        .v2-kpi-dots { display: flex; gap: 3px; align-items: center; }

        .v2-trade-list { display: flex; flex-direction: column; gap: var(--v2-space-xs); }
        .v2-trade-card { cursor: pointer; }

        .v2-trade-compact { display: flex; align-items: center; gap: var(--v2-space-md); }
        .v2-trade-left { display: flex; align-items: center; gap: var(--v2-space-sm); min-width: 160px; }
        .v2-trade-symbol { font-family: var(--v2-font-data); font-weight: 600; font-size: 13px; color: var(--v2-text-primary); }
        .v2-trade-conf { font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-accent-magenta); }
        .v2-trade-prices { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--v2-space-md); flex: 1; }
        .v2-trade-col { display: flex; flex-direction: column; gap: 2px; }
        .v2-trade-lbl { font-family: var(--v2-font-data); font-size: 9px; color: var(--v2-text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
        .v2-trade-val { font-family: var(--v2-font-data); font-size: 12px; color: var(--v2-text-secondary); font-variant-numeric: tabular-nums; }
        .v2-trade-col .v2-ticking-number { font-size: 12px; }
        .v2-profit { color: var(--v2-accent-green); }
        .v2-loss { color: var(--v2-accent-red); }
        .v2-muted { color: var(--v2-text-muted); font-family: var(--v2-font-data); }
        .v2-trade-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; min-width: 80px; }
        .v2-status-tag {
          font-family: var(--v2-font-data); font-size: 9px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1px;
          padding: 2px 8px; border-radius: var(--v2-radius-full); border: 1px solid;
        }
        .v2-status--open { color: var(--v2-accent-cyan); border-color: rgba(0,229,255,0.3); background: rgba(0,229,255,0.06); }
        .v2-status--win { color: var(--v2-accent-green); border-color: rgba(0,230,118,0.3); background: rgba(0,230,118,0.06); }
        .v2-status--loss { color: var(--v2-accent-red); border-color: rgba(255,23,68,0.3); background: rgba(255,23,68,0.06); }
        .v2-trade-time { font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-text-muted); }
        .v2-trade-duration { font-family: 'IBM Plex Mono', var(--v2-font-data), monospace; font-size: 10px; color: var(--v2-text-muted); letter-spacing: 0.5px; }

        .v2-trade-detail {
          margin-top: var(--v2-space-md); padding-top: var(--v2-space-md);
          border-top: 1px solid var(--v2-border);
          animation: v2-fade-in-up var(--v2-duration-fast) var(--v2-ease-out);
        }
        .v2-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--v2-space-lg); }
        .v2-detail-section { display: flex; flex-direction: column; gap: var(--v2-space-xs); }
        .v2-detail-title {
          font-family: var(--v2-font-data); font-size: 9px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1.5px;
          color: var(--v2-text-muted); margin-bottom: var(--v2-space-xs);
        }
        .v2-count { color: var(--v2-accent-cyan); margin-left: var(--v2-space-xs); }
        .v2-detail-row {
          display: flex; justify-content: space-between; align-items: center;
          font-family: var(--v2-font-body); font-size: 12px;
          color: var(--v2-text-secondary); padding: 2px 0;
        }
        .v2-detail-num {
          font-family: var(--v2-font-data); font-size: 12px;
          color: var(--v2-text-primary); font-variant-numeric: tabular-nums;
        }

        .v2-signal-list { display: flex; flex-direction: column; gap: 2px; }
        .v2-signal-row { display: flex; align-items: center; gap: var(--v2-space-sm); padding: 3px 0; font-size: 12px; }
        .v2-signal-agent {
          font-family: var(--v2-font-data); font-size: 10px; font-weight: 500;
          color: var(--v2-accent-magenta); text-transform: uppercase; min-width: 80px;
        }
        .v2-signal-type { color: var(--v2-text-secondary); flex: 1; }
        .v2-signal-str { font-family: var(--v2-font-data); font-size: 11px; color: var(--v2-text-primary); min-width: 30px; text-align: right; }

        .v2-reasoning { font-family: var(--v2-font-body); font-size: 12px; color: var(--v2-text-secondary); line-height: 1.5; margin: 0; }

        .v2-btn { padding: 6px 14px; border: 1px solid var(--v2-border-hover); border-radius: var(--v2-radius-sm); font-family: var(--v2-font-data); font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; transition: all var(--v2-duration-fast) var(--v2-ease-out); }
        .v2-btn--ghost { color: var(--v2-text-secondary); background: transparent; }
        .v2-btn--ghost:hover { border-color: var(--v2-accent-cyan); color: var(--v2-accent-cyan); }

        .v2-empty { color: var(--v2-text-muted); font-family: var(--v2-font-body); font-size: 13px; padding: var(--v2-space-xl) 0; text-align: center; }

        @media (max-width: 768px) {
          .v2-trade-compact { flex-direction: column; align-items: stretch; gap: var(--v2-space-sm); }
          .v2-trade-left { min-width: 0; }
          .v2-trade-prices { grid-template-columns: repeat(2, 1fr); }
          .v2-trade-right { flex-direction: row; justify-content: space-between; }
          .v2-detail-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
