import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatMoney, formatPct, timeAgo, fmtPlainPct } from '../lib/format';
import { SignalBadge } from './ui';
import DetailPanel from './DetailPanel';
import { ErrorState } from './StateBlock';

function parseDomains(raw) {
  if (!raw) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch (err) {
    console.warn('[TradeDetail] signal_domains is not valid JSON:', err?.message || err);
    return [];
  }
}

export default function TradeDetail({ trade, open, onClose }) {
  const [signals, setSignals] = useState([]);
  const [signalsError, setSignalsError] = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState(null);

  const tradeId = trade?.id;

  function loadSignals() {
    if (!tradeId) return;
    setSignalsError(null);
    api(`/trades/${tradeId}/signals`)
      .then(setSignals)
      .catch((err) => {
        console.error('[TradeDetail] signals failed:', err);
        setSignals([]);
        setSignalsError(err?.message || 'Failed to load signals');
      });
  }

  useEffect(() => {
    if (!tradeId || !open) return;
    setExplanation(null);
    setExplainError(null);
    loadSignals();
    // loadSignals only depends on tradeId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeId, open]);

  async function explain() {
    setExplainLoading(true);
    setExplainError(null);
    try {
      const res = await api(`/trades/${tradeId}/explain`, { method: 'POST', body: '{}' });
      setExplanation({ text: res.explanation, cost: res.cost_usd });
    } catch (err) {
      console.error('[TradeDetail] explain failed:', err);
      setExplainError(err?.message || 'Failed to generate explanation');
    }
    setExplainLoading(false);
  }

  if (!trade) return null;

  const pnl = parseFloat(trade.pnl_realised || 0);
  const isLong = trade.side === 'buy';
  const domains = parseDomains(trade.signal_domains);

  return (
    <DetailPanel
      open={open}
      onClose={onClose}
      title={`${trade.symbol || 'Trade'} — ${isLong ? 'LONG' : 'SHORT'}`}
    >
      <div className="v2-td-grid">
        <div className="v2-td-section">
          <div className="v2-td-section-title">Position</div>
          <Row label="Symbol" value={trade.symbol} />
          <Row label="Side" value={isLong ? 'LONG' : 'SHORT'} />
          <Row label="Status" value={trade.status} />
          <Row label="Mode" value={trade.mode || 'paper'} />
          <Row label="Confidence" value={fmtPlainPct(trade.confidence, 0)} />
          <Row label="Cycle" value={trade.cycle_number} />
          <Row label="Opened" value={trade.opened_at ? timeAgo(trade.opened_at) : timeAgo(trade.created_at)} />
        </div>

        <div className="v2-td-section">
          <div className="v2-td-section-title">Prices</div>
          <Row label="Entry" value={formatMoney(parseFloat(trade.entry_price))} />
          {parseFloat(trade.exit_price) > 0 && <Row label="Exit" value={formatMoney(parseFloat(trade.exit_price))} />}
          <Row label="TP" value={parseFloat(trade.tp_price) > 0 ? formatMoney(parseFloat(trade.tp_price)) : '—'} />
          <Row label="SL" value={parseFloat(trade.sl_price) > 0 ? formatMoney(parseFloat(trade.sl_price)) : '—'} />
          <Row label="Quantity" value={parseFloat(trade.quantity || 0).toFixed(6)} />
        </div>

        {trade.status === 'closed' && (
          <div className="v2-td-section">
            <div className="v2-td-section-title">Result</div>
            <Row label="P&L" value={formatMoney(pnl)} />
            <Row label="Return" value={formatPct(parseFloat(trade.pnl_pct || 0), 2)} />
            {trade.outcome_class && <Row label="Outcome" value={trade.outcome_class} />}
            {trade.close_reason && <Row label="Close Reason" value={trade.close_reason} />}
            {trade.closed_at && <Row label="Closed" value={timeAgo(trade.closed_at)} />}
          </div>
        )}

        {trade.reasoning && (
          <div className="v2-td-section v2-td-full">
            <div className="v2-td-section-title">Reasoning</div>
            <div className="v2-td-reasoning">{trade.reasoning}</div>
          </div>
        )}

        <div className="v2-td-section v2-td-full">
          <div className="v2-td-section-title">AI Explanation</div>
          {explanation ? (
            <>
              <div className="v2-td-reasoning">{explanation.text}</div>
              <div className="v2-td-explain-meta">haiku · ${Number(explanation.cost || 0).toFixed(4)}</div>
            </>
          ) : (
            <>
              {explainError && <div className="v2-td-error" role="alert">{explainError}</div>}
              <button
                type="button"
                className="v2-explain-btn"
                disabled={explainLoading}
                onClick={explain}
              >
                {explainLoading ? 'Generating...' : explainError ? 'Retry' : 'Explain This Trade'}
              </button>
            </>
          )}
        </div>

        {signalsError && (
          <div className="v2-td-section v2-td-full">
            <ErrorState error={signalsError} onRetry={loadSignals} title="Could not load contributing signals" />
          </div>
        )}

        {signals.length > 0 && (
          <div className="v2-td-section v2-td-full">
            <div className="v2-td-section-title">Contributing Signals ({signals.length})</div>
            <div className="v2-td-signals">
              {signals.map((s, i) => (
                <div key={i} className="v2-td-signal-row">
                  <span className="v2-td-signal-agent">{s.agent_name}</span>
                  <span className="v2-td-signal-type">{s.signal_type}</span>
                  <SignalBadge direction={s.direction} />
                  <span className="v2-td-signal-str">{Math.round(s.strength_at_entry || s.strength)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {domains.length > 0 && (
          <div className="v2-td-section v2-td-full">
            <div className="v2-td-section-title">Signal Domains</div>
            <div className="v2-td-tags">
              {domains.map((d, i) => (
                <span key={i} className="v2-tag">{d}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .v2-td-grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
          gap: var(--v2-space-lg);
        }
        .v2-td-full { grid-column: 1 / -1; }
        .v2-td-section-title {
          font-family: var(--v2-font-data); font-size: 9px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1px; color: var(--v2-text-muted);
          margin-bottom: var(--v2-space-sm);
          padding-bottom: var(--v2-space-xs);
          border-bottom: 1px solid var(--v2-border);
        }
        .v2-td-row {
          display: flex; justify-content: space-between; align-items: center; padding: 3px 0;
        }
        .v2-td-row-label { font-size: 12px; color: var(--v2-text-secondary); }
        .v2-td-row-value {
          font-family: var(--v2-font-data); font-size: 12px;
          font-variant-numeric: tabular-nums; color: var(--v2-text-primary);
        }
        .v2-td-reasoning {
          font-size: 12px; color: var(--v2-text-secondary);
          line-height: 1.6; white-space: pre-wrap;
        }
        .v2-td-error { color: var(--v2-accent-red); font-size: 12px; margin-bottom: var(--v2-space-xs); }
        .v2-td-signal-row {
          display: flex; align-items: center; gap: var(--v2-space-sm);
          padding: 4px 0; border-bottom: 1px solid var(--v2-border);
        }
        .v2-td-signal-row:last-child { border-bottom: none; }
        .v2-td-signal-agent {
          font-family: var(--v2-font-data); font-size: 9px;
          color: var(--v2-accent-magenta); text-transform: uppercase; min-width: 70px;
        }
        .v2-td-signal-type { font-size: 11px; color: var(--v2-text-secondary); flex: 1; }
        .v2-td-signal-str {
          font-family: var(--v2-font-data); font-size: 11px; font-variant-numeric: tabular-nums;
          color: var(--v2-text-primary); min-width: 30px; text-align: right;
        }
        .v2-explain-btn {
          font-family: var(--v2-font-data); font-size: 11px; font-weight: 500;
          padding: 6px 14px; border-radius: var(--v2-radius-sm); cursor: pointer;
          background: var(--v2-fill-2); color: var(--v2-text-secondary);
          border: 1px solid var(--v2-border); transition: all 0.15s;
        }
        .v2-explain-btn:hover:not(:disabled) { background: var(--v2-fill-3); color: var(--v2-text-primary); }
        .v2-explain-btn:disabled { opacity: 0.5; cursor: wait; }
        .v2-td-explain-meta {
          font-family: var(--v2-font-data); font-size: 9px;
          color: var(--v2-text-muted); margin-top: var(--v2-space-xs);
          letter-spacing: 0.5px;
        }
        .v2-td-tags { display: flex; gap: var(--v2-space-xs); flex-wrap: wrap; }
        .v2-tag {
          font-family: var(--v2-font-data); font-size: 9px; font-weight: 500;
          padding: 2px 6px; border-radius: var(--v2-radius-sm);
          background: var(--v2-fill-2); color: var(--v2-text-secondary);
          border: 1px solid var(--v2-border);
        }
      `}</style>
    </DetailPanel>
  );
}

function Row({ label, value }) {
  return (
    <div className="v2-td-row">
      <span className="v2-td-row-label">{label}</span>
      <span className="v2-td-row-value">{value}</span>
    </div>
  );
}
