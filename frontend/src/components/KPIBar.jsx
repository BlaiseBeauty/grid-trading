import { useEffect, useMemo } from 'react';
import { useDataStore } from '../stores/data';
import GlowCard from './ui/GlowCard';
import TickingNumber from './ui/TickingNumber';
import ProgressRing from './ui/ProgressRing';
import StatusPulse from './ui/StatusPulse';
import CountdownTimer from './ui/CountdownTimer';

function getNextCycleTime() {
  const now = new Date();
  const h = now.getUTCHours();
  const nextSlot = Math.ceil((h + 1) / 4) * 4; // next 4h boundary
  const target = new Date(now);
  target.setUTCHours(nextSlot, 0, 0, 0);
  if (target <= now) target.setUTCHours(target.getUTCHours() + 4);
  return target;
}

export default function KPIBar() {
  const portfolioValue = useDataStore(s => s.portfolioValue);
  const realisedPnl = useDataStore(s => s.realisedPnl);
  const tradeStats = useDataStore(s => s.tradeStats);
  const openTrades = useDataStore(s => s.openTrades);
  const prices = useDataStore(s => s.prices);
  const costs = useDataStore(s => s.costs);
  const lastCycle = useDataStore(s => s.lastCycle);
  const fetchPortfolio = useDataStore(s => s.fetchPortfolio);
  const fetchSystem = useDataStore(s => s.fetchSystem);
  const fetchTrades = useDataStore(s => s.fetchTrades);
  const fetchPrices = useDataStore(s => s.fetchPrices);

  // Fetch fresh data on mount
  useEffect(() => {
    fetchPortfolio();
    fetchSystem();
    fetchTrades();
    fetchPrices();
  }, []);

  // Re-fetch when a cycle completes (lastCycle changes via WebSocket)
  useEffect(() => {
    if (!lastCycle) return;
    fetchPortfolio();
    fetchTrades();
  }, [lastCycle]);

  // Live unrealised P&L from current prices
  const liveUnrealisedPnl = useMemo(() => {
    return (openTrades || []).reduce((sum, t) => {
      const entry = parseFloat(t.actual_fill_price || t.entry_price);
      const qty = parseFloat(t.quantity);
      const curPrice = prices[t.symbol.replace('/', '-')]?.price;
      if (!curPrice) return sum;
      return sum + (t.side === 'buy' ? (curPrice - entry) * qty : (entry - curPrice) * qty);
    }, 0);
  }, [openTrades, prices]);

  const totalPnl = realisedPnl + liveUnrealisedPnl;
  const winRate = parseFloat(tradeStats?.win_rate || 0);
  const totalCost = costs?.total_spend ? parseFloat(costs.total_spend) : 0;
  const openCount = openTrades?.length || 0;
  const nextCycle = useMemo(() => getNextCycleTime(), [lastCycle]);

  const pnlGlow = totalPnl >= 0 ? 'green' : 'red';

  return (
    <div className="kpi-bar-v2">
      {/* Portfolio Value */}
      <GlowCard glowColor="cyan" padding="12px 16px">
        <div className="kpi-label">Portfolio Value</div>
        <TickingNumber value={portfolioValue || 10000} format="money" colorize={false} />
      </GlowCard>

      {/* Total P&L */}
      <GlowCard glowColor={pnlGlow} padding="12px 16px">
        <div className="kpi-label">Total P&L</div>
        <TickingNumber value={totalPnl} format="money" />
      </GlowCard>

      {/* Win Rate */}
      <GlowCard glowColor="cyan" padding="12px 16px">
        <div className="kpi-label">Win Rate</div>
        <div className="kpi-ring-row">
          <ProgressRing value={winRate} size={48} strokeWidth={3} />
        </div>
      </GlowCard>

      {/* Open Positions */}
      <GlowCard glowColor="cyan" padding="12px 16px">
        <div className="kpi-label">Open Positions</div>
        <div className="kpi-positions-row">
          <span className="kpi-positions-count">{openCount}</span>
          <span className="kpi-positions-dots">
            {Array.from({ length: Math.min(openCount, 8) }, (_, i) => (
              <StatusPulse key={i} status="active" size={6} />
            ))}
          </span>
        </div>
      </GlowCard>

      {/* AI Cost */}
      <GlowCard glowColor="magenta" padding="12px 16px">
        <div className="kpi-label">AI Cost</div>
        <TickingNumber value={totalCost} format="money" colorize={false} className="kpi-cost-value" />
      </GlowCard>

      {/* Next Cycle */}
      <GlowCard glowColor="cyan" padding="12px 16px">
        <div className="kpi-label">Next Cycle</div>
        <CountdownTimer targetTime={nextCycle} />
      </GlowCard>

      <style>{`
        .kpi-bar-v2 {
          display: flex;
          gap: 8px;
          overflow-x: auto;
          padding-bottom: 4px;
          margin-bottom: var(--v2-space-lg, 16px);
        }
        .kpi-bar-v2::-webkit-scrollbar { height: 4px; }
        .kpi-bar-v2::-webkit-scrollbar-thumb { background: var(--v2-border, rgba(255,255,255,0.08)); border-radius: 2px; }

        .kpi-bar-v2 > .v2-glow-card {
          flex: 1;
          min-width: 130px;
        }

        .kpi-label {
          font-family: var(--v2-font-label, 'Instrument Sans', sans-serif);
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--v2-text-muted, #4a5068);
          margin-bottom: 6px;
        }

        .kpi-ring-row {
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .kpi-positions-row {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .kpi-positions-count {
          font-family: var(--v2-font-data, 'JetBrains Mono', monospace);
          font-size: 20px;
          font-weight: 500;
          color: var(--v2-text-primary, #f4f5f9);
          font-variant-numeric: tabular-nums;
        }
        .kpi-positions-dots {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
        }

        .kpi-cost-value {
          color: var(--v2-accent-magenta, #a78bfa) !important;
        }
      `}</style>
    </div>
  );
}
