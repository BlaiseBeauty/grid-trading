import { useEffect, useState } from 'react';
import { useDataStore } from '../stores/data';
import { api } from '../lib/api';
import { formatMoney, formatPct, formatPrice, timeAgo } from '../lib/format';
import TradeDetail from '../components/TradeDetail';

export default function Trades() {
  const { fetchTrades, fetchPortfolio, trades, openTrades, tradeStats } = useDataStore();
  const [filter, setFilter] = useState('all');
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [standingOrders, setStandingOrders] = useState([]);
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [orderForm, setOrderForm] = useState({ symbol: 'BTC/USDT', side: 'buy', price: '', confidence: 60, expires_hours: 24 });

  useEffect(() => { fetchTrades(); fetchPortfolio(); loadStandingOrders(); }, []);

  async function loadStandingOrders() {
    try { setStandingOrders(await api('/standing-orders/active')); } catch {}
  }

  async function createStandingOrder() {
    try {
      await api('/standing-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: orderForm.symbol,
          side: orderForm.side,
          conditions: { trigger_price: parseFloat(orderForm.price) },
          execution_params: {},
          confidence: orderForm.confidence,
          expires_hours: orderForm.expires_hours,
        }),
      });
      setShowNewOrder(false);
      setOrderForm({ symbol: 'BTC/USDT', side: 'buy', price: '', confidence: 60, expires_hours: 24 });
      loadStandingOrders();
    } catch (err) { console.error('Create order failed:', err); }
  }

  async function cancelOrder(id) {
    try {
      await api(`/standing-orders/${id}/cancel`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      loadStandingOrders();
    } catch {}
  }

  const filtered = filter === 'all' ? trades
    : filter === 'open' ? openTrades
    : trades.filter(t => t.status === filter);

  return (
    <div className="trades-page">
      <div className="page-header">
        <h1 className="page-title">TRADES</h1>
        <div className="filter-bar">
          {['all', 'open', 'closed'].map(f => (
            <button
              key={f}
              className={`filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >{f}</button>
          ))}
        </div>
      </div>

      {/* Stats Row */}
      {tradeStats && (
        <div className="stats-row">
          <div className="stat-item">
            <span className="stat-label">Total Trades</span>
            <span className="num stat-value">{tradeStats.total_closed || 0}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Win Rate</span>
            <span className="stat-value">{formatPct(parseFloat(tradeStats.win_rate || 0))}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Total P&L</span>
            <span className="stat-value">{formatMoney(parseFloat(tradeStats.total_pnl || 0))}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Avg Return</span>
            <span className="stat-value">{formatPct(parseFloat(tradeStats.avg_return_pct || 0))}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Open</span>
            <span className="num stat-value">{tradeStats.total_open || 0}</span>
          </div>
        </div>
      )}

      {/* Trade Table */}
      <div className="panel">
        <div className="panel-title">Trade History ({filtered.length})</div>
        <div className="trades-table">
          <div className="t-header">
            <span className="t-col t-symbol">Symbol</span>
            <span className="t-col t-side">Side</span>
            <span className="t-col t-entry">Entry</span>
            <span className="t-col t-exit">Exit</span>
            <span className="t-col t-pnl">P&L</span>
            <span className="t-col t-pct">Return</span>
            <span className="t-col t-conf">Conf</span>
            <span className="t-col t-status">Status</span>
            <span className="t-col t-time">Time</span>
          </div>
          {filtered.length === 0 && (
            <div className="empty-state">No trades to display</div>
          )}
          {filtered.map((t, i) => (
            <div key={i} className="t-row clickable" onClick={() => setSelectedTrade(t)}>
              <span className="t-col t-symbol">{t.symbol}</span>
              <span className="t-col t-side">
                <span className={`badge badge-${t.side === 'buy' ? 'profit' : 'loss'}`}>
                  {t.side === 'buy' ? 'LONG' : 'SHORT'}
                </span>
              </span>
              <span className="t-col t-entry num">{formatPrice(t.entry_price)}</span>
              <span className="t-col t-exit num">{t.exit_price ? formatPrice(t.exit_price) : '\u2014'}</span>
              <span className="t-col t-pnl">{t.pnl_realised != null ? formatMoney(parseFloat(t.pnl_realised)) : '\u2014'}</span>
              <span className="t-col t-pct">{t.pnl_pct != null ? formatPct(parseFloat(t.pnl_pct)) : '\u2014'}</span>
              <span className="t-col t-conf num" style={{ color: 'var(--ai)' }}>{t.confidence || '\u2014'}</span>
              <span className="t-col t-status">
                <span className={`badge badge-${t.status === 'open' ? 'cyan' : t.pnl_realised > 0 ? 'profit' : t.pnl_realised < 0 ? 'loss' : 'neutral'}`}>
                  {t.status}
                </span>
              </span>
              <span className="t-col t-time">{timeAgo(t.closed_at || t.opened_at || t.created_at)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Standing Orders */}
      <div className="panel">
        <div className="so-header">
          <span className="panel-title">Standing Orders ({standingOrders.length})</span>
          <button className="action-btn" onClick={() => setShowNewOrder(!showNewOrder)}>
            {showNewOrder ? 'Cancel' : '+ New Order'}
          </button>
        </div>

        {showNewOrder && (
          <div className="so-form">
            <select value={orderForm.symbol} onChange={e => setOrderForm(f => ({ ...f, symbol: e.target.value }))}>
              <option>BTC/USDT</option><option>ETH/USDT</option><option>SOL/USDT</option>
            </select>
            <select value={orderForm.side} onChange={e => setOrderForm(f => ({ ...f, side: e.target.value }))}>
              <option value="buy">LONG</option><option value="sell">SHORT</option>
            </select>
            <input type="number" placeholder="Trigger price" value={orderForm.price}
              onChange={e => setOrderForm(f => ({ ...f, price: e.target.value }))} />
            <input type="number" placeholder="Confidence" value={orderForm.confidence} min="1" max="100"
              onChange={e => setOrderForm(f => ({ ...f, confidence: parseInt(e.target.value) || 50 }))} />
            <input type="number" placeholder="Expires (hours)" value={orderForm.expires_hours} min="1"
              onChange={e => setOrderForm(f => ({ ...f, expires_hours: parseInt(e.target.value) || 24 }))} />
            <button className="action-btn primary" onClick={createStandingOrder}>Create</button>
          </div>
        )}

        {standingOrders.length === 0 && !showNewOrder && (
          <div className="empty-state">No active standing orders</div>
        )}
        {standingOrders.map((o, i) => (
          <div key={i} className="so-row">
            <span className="so-symbol">{o.symbol}</span>
            <span className={`badge badge-${o.side === 'buy' ? 'profit' : 'loss'}`}>
              {o.side === 'buy' ? 'LONG' : 'SHORT'}
            </span>
            <span className="num so-price">
              {o.conditions?.trigger_price ? formatPrice(o.conditions.trigger_price) : '—'}
            </span>
            <span className="num so-conf" style={{ color: 'var(--ai)' }}>{o.confidence}%</span>
            <span className="so-expires">{timeAgo(o.expires_at)}</span>
            <button className="so-cancel" onClick={() => cancelOrder(o.id)}>Cancel</button>
          </div>
        ))}
      </div>

      <TradeDetail
        trade={selectedTrade}
        open={!!selectedTrade}
        onClose={() => setSelectedTrade(null)}
      />

      <style>{`
        .trades-page { display: flex; flex-direction: column; gap: var(--space-lg); }
        .page-header { display: flex; justify-content: space-between; align-items: center; }
        .page-title {
          font-family: 'Syne', sans-serif; font-weight: 800; font-size: 18px;
          letter-spacing: 6px; color: var(--t2);
        }
        .filter-bar { display: flex; gap: 2px; }
        .filter-btn {
          padding: var(--space-sm) var(--space-md);
          font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 0.5px; color: var(--t3);
          border: 1px solid var(--border-1); background: var(--surface);
          transition: all var(--transition-fast);
        }
        .filter-btn:first-child { border-radius: var(--radius-sm) 0 0 var(--radius-sm); }
        .filter-btn:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
        .filter-btn.active { color: var(--cyan); border-color: var(--cyan); background: rgba(0,229,255,0.05); }
        .stats-row {
          display: flex; gap: var(--panel-gap); overflow-x: auto;
        }
        .stat-item {
          background: var(--surface); border: 1px solid var(--border-1);
          border-radius: var(--radius-md); padding: var(--space-md) var(--space-lg);
          min-width: 140px;
        }
        .stat-label {
          font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1px; color: var(--t4);
          display: block; margin-bottom: var(--space-xs);
        }
        .stat-value { font-size: 18px; font-weight: 300; }
        .trades-table { overflow-x: auto; }
        .t-header, .t-row {
          display: grid;
          grid-template-columns: 100px 70px 100px 100px 100px 80px 50px 70px 80px;
          gap: var(--space-sm); align-items: center; padding: var(--space-sm) 0;
        }
        .t-header {
          font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1px; color: var(--t4);
          border-bottom: 1px solid var(--border-1);
        }
        .t-row { font-size: 12px; border-bottom: 1px solid var(--border-0); }
        .t-row:hover { background: var(--elevated); }
        .t-row.clickable { cursor: pointer; }
        .t-symbol { font-family: 'IBM Plex Mono', monospace; font-weight: 500; }
        .t-time { font-size: 10px; color: var(--t4); }
        .empty-state { color: var(--t4); font-size: 13px; padding: var(--space-xl); text-align: center; }
        .so-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-md); }
        .so-header .panel-title { margin-bottom: 0; }
        .action-btn {
          padding: var(--space-sm) var(--space-lg); border: 1px solid var(--border-2);
          border-radius: var(--radius-sm); font-family: 'IBM Plex Mono', monospace;
          font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;
          color: var(--t2); transition: all var(--transition-fast); cursor: pointer;
        }
        .action-btn:hover { border-color: var(--cyan); color: var(--cyan); }
        .action-btn.primary { background: var(--cyan); color: var(--void); border-color: var(--cyan); }
        .so-form {
          display: flex; gap: var(--space-sm); flex-wrap: wrap; align-items: center;
          padding: var(--space-md) 0; border-bottom: 1px solid var(--border-0);
          margin-bottom: var(--space-md);
        }
        .so-form input, .so-form select { max-width: 140px; }
        .so-row {
          display: flex; align-items: center; gap: var(--space-sm);
          padding: var(--space-sm) 0; border-bottom: 1px solid var(--border-0); font-size: 12px;
        }
        .so-symbol { font-family: 'IBM Plex Mono', monospace; font-weight: 500; min-width: 80px; }
        .so-price { min-width: 80px; }
        .so-conf { min-width: 35px; }
        .so-expires { color: var(--t4); font-size: 10px; flex: 1; }
        .so-cancel {
          font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: var(--t4);
          cursor: pointer; transition: color var(--transition-fast);
        }
        .so-cancel:hover { color: var(--red); }
      `}</style>
    </div>
  );
}
