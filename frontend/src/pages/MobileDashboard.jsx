import { useEffect, useState, useRef, useCallback } from 'react';
import { useDataStore } from '../stores/data';
import {
  TickingNumber, GlowCard, StatusPulse, SignalBadge,
  ProgressRing, CountdownTimer, RangeBar,
} from '../components/ui';
import { timeAgo, formatPrice } from '../lib/format';

const MARKET_SYMBOLS = [
  { key: 'BTC-USDT', label: 'BTC' },
  { key: 'ETH-USDT', label: 'ETH' },
  { key: 'SOL-USDT', label: 'SOL' },
];

function getNextCycleTime() {
  const now = new Date();
  const hours = now.getUTCHours();
  const nextSlot = Math.ceil((hours + 1) / 4) * 4;
  const next = new Date(now);
  next.setUTCHours(nextSlot >= 24 ? 0 : nextSlot, 0, 0, 0);
  if (nextSlot >= 24) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function getSignalForSymbol(signals, symbol) {
  if (!signals?.length) return null;
  const match = signals.find(s => s.symbol === symbol && s.direction);
  return match?.direction || null;
}

// ── Position Card ──
function MobilePositionCard({ trade, prices, expanded, onToggle }) {
  const currentPrice = prices[trade.symbol]?.price;
  const entry = parseFloat(trade.entry_price);
  const qty = parseFloat(trade.quantity || 0);
  const side = trade.side || 'buy';
  const pnlRaw = currentPrice && entry
    ? (side === 'buy' ? (currentPrice - entry) : (entry - currentPrice)) * qty
    : null;
  const pnlPct = entry ? ((pnlRaw || 0) / (entry * qty)) * 100 : 0;

  return (
    <div className="mob-position-card" onClick={onToggle}>
      <div className="mob-position-header">
        <div className="mob-position-left">
          <span className="mob-position-symbol">{trade.symbol?.replace('-USDT', '')}</span>
          <span className={`mob-side-badge mob-side-${side}`}>
            {side === 'buy' ? 'LONG' : 'SHORT'}
          </span>
        </div>
        <div className="mob-position-right">
          {pnlRaw != null && (
            <TickingNumber value={pnlRaw} format="money" decimals={2} />
          )}
          <span className={`mob-pnl-pct ${pnlPct >= 0 ? 'profit' : 'loss'}`}>
            {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
          </span>
        </div>
      </div>

      {expanded && (
        <div className="mob-position-detail">
          <div className="mob-detail-row">
            <span className="mob-detail-label">Entry</span>
            <span className="num">{formatPrice(entry)}</span>
          </div>
          <div className="mob-detail-row">
            <span className="mob-detail-label">Current</span>
            <span className="num">{currentPrice ? formatPrice(currentPrice) : '—'}</span>
          </div>
          <div className="mob-detail-row">
            <span className="mob-detail-label">Qty</span>
            <span className="num">{qty}</span>
          </div>
          <div className="mob-detail-row">
            <span className="mob-detail-label">Opened</span>
            <span>{timeAgo(trade.opened_at || trade.created_at)}</span>
          </div>
          {trade.stop_loss && trade.take_profit && (
            <div style={{ marginTop: 8 }}>
              <RangeBar
                current={currentPrice || entry}
                low={parseFloat(trade.stop_loss)}
                high={parseFloat(trade.take_profit)}
                side={side}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Component ──
export default function MobileDashboard() {
  const {
    portfolioValue, realisedPnl, tradeStats,
    prices, openTrades, signals, feed, lastCycle,
    system, cycleStatus,
    fetchPortfolio, fetchTrades, fetchSignals, fetchSystem, fetchPrices,
    triggerCycle, refreshData,
  } = useDataStore();

  const [expandedTrade, setExpandedTrade] = useState(null);
  const [nextCycle] = useState(getNextCycleTime);
  const [cycleLoading, setCycleLoading] = useState(false);

  // Pull-to-refresh state
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const touchStartY = useRef(0);
  const containerRef = useRef(null);

  useEffect(() => {
    fetchPortfolio();
    fetchTrades();
    fetchSignals();
    fetchSystem();
    fetchPrices();
  }, []);

  // Pull-to-refresh handlers
  const onTouchStart = useCallback((e) => {
    if (containerRef.current?.scrollTop === 0) {
      touchStartY.current = e.touches[0].clientY;
    }
  }, []);

  const onTouchMove = useCallback((e) => {
    if (refreshing) return;
    if (containerRef.current?.scrollTop > 0) return;
    const diff = e.touches[0].clientY - touchStartY.current;
    if (diff > 0) {
      setPullDistance(Math.min(diff * 0.5, 100));
    }
  }, [refreshing]);

  const onTouchEnd = useCallback(async () => {
    if (pullDistance >= 80) {
      setRefreshing(true);
      setPullDistance(80);
      await Promise.all([
        fetchPortfolio(), fetchTrades(), fetchSignals(),
        fetchSystem(), fetchPrices(),
      ]);
      setRefreshing(false);
    }
    setPullDistance(0);
  }, [pullDistance, fetchPortfolio, fetchTrades, fetchSignals, fetchSystem, fetchPrices]);

  const handleCycle = async () => {
    setCycleLoading(true);
    try { await triggerCycle(); } catch {}
    setCycleLoading(false);
  };

  const handleRefresh = async () => {
    try { await refreshData(); } catch {}
    fetchPortfolio();
    fetchTrades();
    fetchSignals();
    fetchPrices();
  };

  const winRate = tradeStats?.win_rate ?? 0;
  const totalTrades = tradeStats?.total_trades ?? 0;
  const feedItems = (feed || []).slice(0, 5);

  const isRunning = cycleStatus?.running;

  return (
    <div
      ref={containerRef}
      className="mob-container"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Pull-to-refresh indicator */}
      {pullDistance > 0 && (
        <div className="mob-pull-indicator" style={{ height: pullDistance }}>
          <div className={`mob-pull-spinner ${refreshing ? 'mob-spinning' : ''}`}
               style={{ opacity: pullDistance / 80 }}>
            {refreshing ? '...' : pullDistance >= 80 ? 'Release' : 'Pull'}
          </div>
        </div>
      )}

      {/* ── Portfolio Hero ── */}
      <section className="mob-hero">
        <div className="mob-hero-label">Portfolio Value</div>
        <div className="mob-hero-value">
          <TickingNumber value={portfolioValue} format="money" decimals={2} colorize={false} flash={false} />
        </div>
        <div className="mob-hero-pnl">
          <TickingNumber value={realisedPnl} format="money" decimals={2} prefix="" />
          <span className="mob-hero-pnl-label">realised</span>
        </div>
        <div className="mob-hero-ring">
          <ProgressRing
            value={winRate}
            size={52}
            strokeWidth={4}
            color={winRate >= 50 ? 'var(--v2-accent-green)' : 'var(--v2-accent-red)'}
          />
          <span className="mob-hero-ring-label">{totalTrades} trades</span>
        </div>
      </section>

      {/* ── Price Strip ── */}
      <section className="mob-price-strip">
        {MARKET_SYMBOLS.map(({ key, label }) => {
          const p = prices[key];
          const direction = getSignalForSymbol(signals, key);
          return (
            <GlowCard key={key} className="mob-price-card" padding="12px">
              <div className="mob-price-symbol">{label}</div>
              <div className="mob-price-value">
                <TickingNumber
                  value={p?.price || 0}
                  format="money"
                  decimals={p?.price >= 1000 ? 2 : p?.price >= 1 ? 4 : 6}
                  colorize={false}
                  flash
                />
              </div>
              <div className="mob-price-change">
                {p?.change24h != null && (
                  <TickingNumber value={p.change24h} format="pct" decimals={1} />
                )}
              </div>
              {direction && (
                <div style={{ marginTop: 4 }}>
                  <SignalBadge direction={direction} size="sm" />
                </div>
              )}
            </GlowCard>
          );
        })}
      </section>

      {/* ── Open Positions ── */}
      {openTrades?.length > 0 && (
        <section className="mob-section">
          <div className="mob-section-title">Open Positions ({openTrades.length})</div>
          {openTrades.map((trade) => (
            <MobilePositionCard
              key={trade.id}
              trade={trade}
              prices={prices}
              expanded={expandedTrade === trade.id}
              onToggle={() => setExpandedTrade(expandedTrade === trade.id ? null : trade.id)}
            />
          ))}
        </section>
      )}

      {/* ── Quick Actions ── */}
      <section className="mob-actions">
        <button
          className="mob-btn mob-btn-primary"
          onClick={handleCycle}
          disabled={cycleLoading || isRunning}
        >
          {cycleLoading || isRunning ? (
            <span className="mob-btn-loading">Running...</span>
          ) : 'RUN CYCLE'}
        </button>
        <button className="mob-btn mob-btn-outline" onClick={handleRefresh}>
          REFRESH
        </button>
      </section>

      {/* ── Recent Activity ── */}
      <section className="mob-section">
        <div className="mob-section-title">Recent Activity</div>
        {feedItems.length > 0 ? feedItems.map((item, i) => (
          <div key={i} className="mob-feed-item">
            <span className="mob-feed-type">{item.type}</span>
            <span className="mob-feed-msg">{item.message || item.summary || '—'}</span>
            <span className="mob-feed-time">{timeAgo(item.ts)}</span>
          </div>
        )) : (
          <div className="mob-empty">No recent activity</div>
        )}

        {lastCycle && (
          <div className="mob-last-cycle">
            <span className="mob-detail-label">Last Cycle #{lastCycle.cycle_number}</span>
            <span className="mob-feed-time">{timeAgo(lastCycle.completed_at || lastCycle.started_at)}</span>
            {lastCycle.proposals != null && (
              <span className="mob-cycle-stats">
                {lastCycle.proposals} proposed / {lastCycle.approved ?? 0} approved / {lastCycle.executed ?? 0} exec
              </span>
            )}
          </div>
        )}
      </section>

      {/* ── System Status ── */}
      <section className="mob-section mob-system">
        <div className="mob-section-title">System</div>
        <div className="mob-system-row">
          <StatusPulse status="active" label="Node" />
          <StatusPulse
            status={system?.python_engine ? 'active' : 'error'}
            label="Python"
          />
          <StatusPulse
            status={system?.database ? 'active' : 'error'}
            label="Postgres"
          />
        </div>
        <div className="mob-system-row" style={{ marginTop: 8 }}>
          <CountdownTimer targetTime={nextCycle} label="Next cycle" />
        </div>
        <div className="mob-system-row" style={{ marginTop: 8 }}>
          {system?.bootstrap_phase && (
            <span className="badge badge-cyan">{system.bootstrap_phase}</span>
          )}
          <span className={`badge ${system?.live_trading ? 'badge-loss' : 'badge-profit'}`}>
            {system?.live_trading ? 'LIVE' : 'PAPER'}
          </span>
        </div>
      </section>

      {/* Bottom safe area spacer */}
      <div className="mob-safe-bottom" />

      <style>{`
        .mob-container {
          min-height: 100vh;
          background: var(--v2-bg-primary, var(--void));
          padding: 16px;
          padding-top: 12px;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior-y: contain;
        }

        .mob-pull-indicator {
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .mob-pull-spinner {
          font-family: var(--v2-font-data, 'IBM Plex Mono', monospace);
          font-size: 12px;
          color: var(--cyan);
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        .mob-spinning {
          animation: v2-spin 1s linear infinite;
        }

        /* ── Hero ── */
        .mob-hero {
          text-align: center;
          padding: 20px 0 16px;
          position: relative;
        }
        .mob-hero-label {
          font-family: var(--v2-font-body, 'Outfit', sans-serif);
          font-size: 12px;
          color: var(--t3);
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 4px;
        }
        .mob-hero-value {
          font-size: 32px;
          font-weight: 500;
          color: var(--t1);
        }
        .mob-hero-value .v2-ticking-number {
          color: var(--t1) !important;
        }
        .mob-hero-pnl {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          margin-top: 4px;
          font-size: 14px;
        }
        .mob-hero-pnl-label {
          font-size: 11px;
          color: var(--t3);
          text-transform: uppercase;
        }
        .mob-hero-ring {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          margin-top: 12px;
        }
        .mob-hero-ring-label {
          font-family: var(--v2-font-data, 'IBM Plex Mono', monospace);
          font-size: 11px;
          color: var(--t3);
        }

        /* ── Price Strip ── */
        .mob-price-strip {
          display: flex;
          gap: 10px;
          overflow-x: auto;
          scroll-snap-type: x mandatory;
          -webkit-overflow-scrolling: touch;
          padding: 4px 0 12px;
        }
        .mob-price-strip::-webkit-scrollbar { display: none; }
        .mob-price-card {
          min-width: 120px;
          flex-shrink: 0;
          scroll-snap-align: start;
          text-align: center;
        }
        .mob-price-symbol {
          font-family: var(--v2-font-heading, 'Instrument Sans', sans-serif);
          font-weight: 600;
          font-size: 13px;
          color: var(--t2);
          letter-spacing: 1px;
          margin-bottom: 4px;
        }
        .mob-price-value {
          font-size: 16px;
        }
        .mob-price-change {
          font-size: 13px;
          margin-top: 2px;
        }

        /* ── Sections ── */
        .mob-section {
          margin-top: 16px;
        }
        .mob-section-title {
          font-family: var(--v2-font-heading, 'Instrument Sans', sans-serif);
          font-weight: 600;
          font-size: 12px;
          color: var(--t3);
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 10px;
        }

        /* ── Position Cards ── */
        .mob-position-card {
          background: var(--surface);
          border: 1px solid var(--border-1);
          border-radius: var(--radius-md);
          padding: 12px;
          margin-bottom: 8px;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }
        .mob-position-card:active { opacity: 0.7; }
        .mob-position-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .mob-position-left {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .mob-position-symbol {
          font-family: var(--v2-font-data, 'IBM Plex Mono', monospace);
          font-weight: 600;
          font-size: 15px;
          color: var(--t1);
        }
        .mob-side-badge {
          font-family: var(--v2-font-data, 'IBM Plex Mono', monospace);
          font-size: 9px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 2px 6px;
          border-radius: var(--radius-sm);
        }
        .mob-side-buy { color: var(--profit); background: rgba(0,255,136,0.10); }
        .mob-side-sell { color: var(--loss); background: rgba(255,45,85,0.10); }
        .mob-position-right {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
        }
        .mob-pnl-pct {
          font-family: var(--v2-font-data, 'IBM Plex Mono', monospace);
          font-size: 11px;
        }
        .mob-position-detail {
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid var(--border-1);
        }
        .mob-detail-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 3px 0;
          font-size: 13px;
        }
        .mob-detail-label {
          color: var(--t3);
          font-size: 12px;
        }

        /* ── Quick Actions ── */
        .mob-actions {
          display: flex;
          gap: 10px;
          margin-top: 16px;
        }
        .mob-btn {
          flex: 1;
          min-height: 44px;
          border-radius: var(--radius-md);
          font-family: var(--v2-font-data, 'IBM Plex Mono', monospace);
          font-weight: 600;
          font-size: 13px;
          letter-spacing: 1px;
          text-transform: uppercase;
          -webkit-tap-highlight-color: transparent;
        }
        .mob-btn:active { opacity: 0.7; }
        .mob-btn:disabled { opacity: 0.4; }
        .mob-btn-primary {
          background: var(--cyan);
          color: var(--void);
        }
        .mob-btn-outline {
          background: transparent;
          border: 1px solid var(--border-2);
          color: var(--t2);
        }
        .mob-btn-loading {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }

        /* ── Feed ── */
        .mob-feed-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 0;
          border-bottom: 1px solid var(--border-0);
          font-size: 13px;
        }
        .mob-feed-type {
          font-family: var(--v2-font-data, 'IBM Plex Mono', monospace);
          font-size: 9px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--cyan);
          background: rgba(0,229,255,0.10);
          padding: 2px 6px;
          border-radius: var(--radius-sm);
          flex-shrink: 0;
        }
        .mob-feed-msg {
          flex: 1;
          color: var(--t2);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .mob-feed-time {
          font-family: var(--v2-font-data, 'IBM Plex Mono', monospace);
          font-size: 10px;
          color: var(--t4);
          flex-shrink: 0;
        }
        .mob-empty {
          color: var(--t4);
          font-size: 13px;
          padding: 12px 0;
        }
        .mob-last-cycle {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 10px 0 0;
          font-size: 12px;
        }
        .mob-cycle-stats {
          font-family: var(--v2-font-data, 'IBM Plex Mono', monospace);
          font-size: 10px;
          color: var(--t3);
        }

        /* ── System ── */
        .mob-system .mob-system-row {
          display: flex;
          align-items: center;
          gap: 16px;
          flex-wrap: wrap;
        }

        /* ── Bottom safe area ── */
        .mob-safe-bottom {
          height: env(safe-area-inset-bottom, 16px);
          min-height: 16px;
        }
      `}</style>
    </div>
  );
}
