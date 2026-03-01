import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatMoney, formatPct, timeAgo } from '../lib/format';
import Modal from './Modal';

export default function TradeDetail({ trade, open, onClose }) {
  const [signals, setSignals] = useState([]);

  useEffect(() => {
    if (!trade?.id || !open) return;
    api(`/trades/${trade.id}/signals`).then(setSignals).catch(() => setSignals([]));
  }, [trade?.id, open]);

  if (!trade) return null;

  const pnl = parseFloat(trade.pnl_realised || 0);
  const isLong = trade.side === 'buy';

  return (
    <Modal open={open} onClose={onClose} title={`${trade.symbol} — ${isLong ? 'LONG' : 'SHORT'}`}>
      <div className="td-grid">
        <div className="td-section">
          <div className="td-section-title">Position</div>
          <Row label="Symbol" value={trade.symbol} />
          <Row label="Side" value={isLong ? 'LONG' : 'SHORT'} className={isLong ? 'profit' : 'loss'} />
          <Row label="Status" value={trade.status} />
          <Row label="Mode" value={trade.mode || 'paper'} />
          <Row label="Confidence" value={`${trade.confidence || '—'}%`} />
          <Row label="Cycle" value={trade.cycle_number} />
          <Row label="Opened" value={trade.opened_at ? timeAgo(trade.opened_at) : timeAgo(trade.created_at)} />
        </div>

        <div className="td-section">
          <div className="td-section-title">Prices</div>
          <Row label="Entry" value={formatMoney(parseFloat(trade.entry_price))} />
          {trade.exit_price && <Row label="Exit" value={formatMoney(parseFloat(trade.exit_price))} />}
          <Row label="TP" value={trade.tp_price ? formatMoney(parseFloat(trade.tp_price)) : '—'} />
          <Row label="SL" value={trade.sl_price ? formatMoney(parseFloat(trade.sl_price)) : '—'} />
          <Row label="Quantity" value={parseFloat(trade.quantity || 0).toFixed(6)} />
        </div>

        {trade.status === 'closed' && (
          <div className="td-section">
            <div className="td-section-title">Result</div>
            <Row label="P&L" value={formatMoney(pnl)} className={pnl >= 0 ? 'profit' : 'loss'} />
            <Row label="Return" value={formatPct(parseFloat(trade.pnl_pct || 0), 2)} className={pnl >= 0 ? 'profit' : 'loss'} />
            {trade.outcome_class && <Row label="Outcome" value={trade.outcome_class} />}
            {trade.closed_at && <Row label="Closed" value={timeAgo(trade.closed_at)} />}
          </div>
        )}

        {trade.reasoning && (
          <div className="td-section td-full">
            <div className="td-section-title">Reasoning</div>
            <div className="td-reasoning">{trade.reasoning}</div>
          </div>
        )}

        {signals.length > 0 && (
          <div className="td-section td-full">
            <div className="td-section-title">Contributing Signals ({signals.length})</div>
            <div className="td-signals">
              {signals.map((s, i) => (
                <div key={i} className="td-signal-row">
                  <span className="signal-agent">{s.agent_name}</span>
                  <span className="signal-type">{s.signal_type}</span>
                  <span className={`badge badge-${s.direction === 'bullish' ? 'profit' : s.direction === 'bearish' ? 'loss' : 'neutral'}`}>
                    {s.direction}
                  </span>
                  <span className="num">{Math.round(s.strength_at_entry || s.strength)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {trade.signal_domains && (
          <div className="td-section td-full">
            <div className="td-section-title">Signal Domains</div>
            <div className="td-tags">
              {(() => { try { return typeof trade.signal_domains === 'string' ? JSON.parse(trade.signal_domains) : trade.signal_domains || []; } catch { return []; } })().map((d, i) => (
                <span key={i} className="badge badge-neutral">{d}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .td-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--space-lg);
        }
        .td-full { grid-column: 1 / -1; }
        .td-section-title {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 9px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--t3);
          margin-bottom: var(--space-sm);
          padding-bottom: var(--space-xs);
          border-bottom: 1px solid var(--border-0);
        }
        .td-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 3px 0;
        }
        .td-row-label {
          font-size: 12px;
          color: var(--t3);
        }
        .td-row-value {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          font-variant-numeric: tabular-nums;
          color: var(--t1);
        }
        .td-row-value.profit { color: var(--green); }
        .td-row-value.loss { color: var(--red); }
        .td-reasoning {
          font-size: 12px;
          color: var(--t2);
          line-height: 1.6;
          white-space: pre-wrap;
        }
        .td-signal-row {
          display: flex;
          align-items: center;
          gap: var(--space-sm);
          padding: 4px 0;
          border-bottom: 1px solid var(--border-0);
        }
        .td-signal-row:last-child { border-bottom: none; }
        .td-signal-row .signal-agent {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 9px;
          color: var(--ai);
          text-transform: uppercase;
          min-width: 70px;
        }
        .td-signal-row .signal-type {
          font-size: 11px;
          color: var(--t2);
          flex: 1;
        }
        .td-tags { display: flex; gap: var(--space-xs); flex-wrap: wrap; }
      `}</style>
    </Modal>
  );
}

function Row({ label, value, className = '' }) {
  return (
    <div className="td-row">
      <span className="td-row-label">{label}</span>
      <span className={`td-row-value ${className}`}>{value}</span>
    </div>
  );
}
