import { useDataStore } from '../stores/data';
import { formatMoney, formatPct, formatNum } from '../lib/format';

function KPICard({ label, children }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{children}</div>
      <style>{`
        .kpi-card {
          background: var(--surface);
          border: 1px solid var(--border-1);
          border-radius: var(--radius-md);
          padding: var(--space-md) var(--space-lg);
          min-width: 160px;
        }
        .kpi-label {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 9px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--t3);
          margin-bottom: var(--space-xs);
        }
        .kpi-value {
          font-family: 'IBM Plex Mono', monospace;
          font-weight: 300;
          font-size: 20px;
          font-variant-numeric: tabular-nums;
        }
      `}</style>
    </div>
  );
}

export default function KPIBar() {
  const portfolioValue = useDataStore(s => s.portfolioValue);
  const realisedPnl = useDataStore(s => s.realisedPnl);
  const stats = useDataStore(s => s.tradeStats);
  const openTrades = useDataStore(s => s.openTrades);
  const prices = useDataStore(s => s.prices);
  const costs = useDataStore(s => s.costs);

  // Compute live unrealised P&L from current prices
  const liveUnrealisedPnl = (openTrades || []).reduce((sum, t) => {
    const entry = parseFloat(t.actual_fill_price || t.entry_price);
    const qty = parseFloat(t.quantity);
    const dashSymbol = t.symbol.replace('/', '-');
    const curPrice = prices[dashSymbol]?.price;
    if (!curPrice) return sum;
    const pnl = t.side === 'buy' ? (curPrice - entry) * qty : (entry - curPrice) * qty;
    return sum + pnl;
  }, 0);

  const totalPnl = realisedPnl + liveUnrealisedPnl;
  const winRate = parseFloat(stats?.win_rate || 0);
  const totalCost = costs?.total_spend ? parseFloat(costs.total_spend) : 0;

  return (
    <div className="kpi-bar">
      <KPICard label="Portfolio Value">
        {formatMoney(portfolioValue || 10000)}
      </KPICard>
      <KPICard label="Total P&L">
        {formatMoney(totalPnl)}
      </KPICard>
      <KPICard label="Win Rate">
        <span className="num">{winRate.toFixed(1)}%</span>
      </KPICard>
      <KPICard label="Open Positions">
        <span className="num">{openTrades?.length || 0}</span>
      </KPICard>
      <KPICard label="AI Cost">
        <span className="num" style={{ color: 'var(--ai)' }}>${totalCost.toFixed(2)}</span>
      </KPICard>

      <style>{`
        .kpi-bar {
          display: flex;
          gap: var(--panel-gap);
          overflow-x: auto;
          padding-bottom: var(--space-xs);
        }
      `}</style>
    </div>
  );
}
