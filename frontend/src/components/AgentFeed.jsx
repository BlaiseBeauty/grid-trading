import { useEffect, useRef } from 'react';
import { useDataStore } from '../stores/data';
import { timeAgo } from '../lib/format';
import { StatusPulse } from './ui';

const EVENT_LABELS = {
  trades_executed: 'EXECUTION',
  positions_closed: 'MONITOR',
  standing_order_triggered: 'STANDING ORDER',
  position_review: 'POSITION MGR',
  trade: 'TRADE',
  trade_closed: 'TRADE',
  scram_activated: 'SCRAM',
  scram_cleared: 'SCRAM',
  analysis_complete: 'ANALYSIS',
};

const agentName = (item) =>
  (item.agent_name || item.agent || EVENT_LABELS[item.type] || 'unknown').toUpperCase();

export default function AgentFeed() {
  const feed = useDataStore(s => s.feed);
  const decisions = useDataStore(s => s.decisions);
  const cycleStatus = useDataStore(s => s.cycleStatus);

  const wsItems = feed.slice(0, 50);
  const decisionItems = decisions.slice(0, 15).map(d => ({
    type: 'decision',
    agent_name: d.agent_name,
    ts: new Date(d.created_at).getTime(),
    signals_count: d.output_json?.signals?.length || 0,
    cost_usd: d.cost_usd,
    layer: d.agent_layer,
    error: d.error,
    description: d.agent_layer === 'strategy'
      ? (d.agent_name === 'synthesizer' ? `${d.output_json?.proposals?.length || 0} proposals`
        : d.agent_name === 'regime_classifier' ? `${d.output_json?.regime || 'classified'}`
        : `${d.output_json?.approved?.length || 0} approved`)
      : null,
  }));

  const meaningfulWsItems = wsItems.filter(item =>
    item.type !== 'system' || wsItems.some(i => i.type === 'agent_complete' || i.type === 'cycle_complete')
  );

  const items = meaningfulWsItems.length > 0 ? wsItems : decisionItems;

  const feedRef = useRef(null);
  const prevLengthRef = useRef(items.length);
  const newItemCount = items.length > prevLengthRef.current
    ? items.length - prevLengthRef.current
    : 0;

  useEffect(() => {
    if (newItemCount > 0 && feedRef.current) {
      feedRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
    prevLengthRef.current = items.length;
  }, [items.length]);

  return (
    <div ref={feedRef} className="v2-agent-feed">
      <div className="v2-feed-title">Agent Activity</div>

      {/* Live cycle progress */}
      {cycleStatus?.running && (
        <div className="v2-cycle-progress">
          <div className="v2-cycle-header">
            <div className="v2-cycle-label">
              <StatusPulse status="active" size={6} />
              <span>Cycle {cycleStatus.cycleNumber}</span>
            </div>
            <span className="v2-cycle-count">{cycleStatus.completed.length} / {cycleStatus.agents.length + 3}</span>
          </div>
          <div className="v2-cycle-bar">
            <div
              className="v2-cycle-fill"
              style={{ width: `${(cycleStatus.completed.length / (cycleStatus.agents.length + 3)) * 100}%` }}
            />
          </div>
          <div className="v2-cycle-chips">
            {cycleStatus.agents.map(name => {
              const done = cycleStatus.completed.find(c => c.agent_name === name);
              return (
                <div key={name} className={`v2-chip ${done ? (done.error ? 'v2-chip--error' : 'v2-chip--done') : 'v2-chip--pending'}`}>
                  <span className="v2-chip-name">{name}</span>
                  {done && !done.error && <span className="v2-chip-count">{done.signals_count}</span>}
                  {done?.error && <span className="v2-chip-err">!</span>}
                </div>
              );
            })}
            {['regime_classifier', 'synthesizer', 'risk_manager'].map(name => {
              const done = cycleStatus.completed.find(c => c.agent_name === name);
              return (
                <div key={name} className={`v2-chip v2-chip--strategy ${done ? (done.error ? 'v2-chip--error' : 'v2-chip--done') : 'v2-chip--pending'}`}>
                  <span className="v2-chip-name">{name.replace('_', ' ').replace('regime classifier', 'regime')}</span>
                  {done && !done.error && (
                    <span className="v2-chip-count">
                      {name === 'regime_classifier'
                        ? done.regime
                        : name === 'synthesizer'
                          ? `${done.proposals}p${done.standing_orders ? ` +${done.standing_orders}so` : ''}`
                          : `${done.approved}ok`}
                    </span>
                  )}
                  {done?.error && <span className="v2-chip-err">!</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="v2-feed-list">
        {items.length === 0 && !cycleStatus?.running && (
          <div className="v2-feed-empty">No activity yet. Trigger a cycle to start.</div>
        )}
        {items.map((item, i) => (
          <div key={i} className={`v2-feed-item ${i < newItemCount ? 'v2-slide-in' : ''}`}>
            <div className="v2-feed-left">
              {item.type === 'system' ? (
                <span className="v2-feed-agent v2-feed-agent--system">SYSTEM</span>
              ) : item.type === 'cycle_start' || item.type === 'cycle_complete' ? (
                <span className="v2-feed-agent v2-feed-agent--system">CYCLE</span>
              ) : (
                <span className="v2-feed-agent">{agentName(item)}</span>
              )}
              <span className="v2-feed-text">
                {item.type === 'system'
                  ? item.message
                  : item.type === 'cycle_start'
                    ? `Cycle ${item.cycleNumber} started`
                    : item.type === 'cycle_complete'
                      ? `Cycle ${item.cycleNumber} complete in ${item.elapsed}`
                      : item.type === 'agent_complete'
                        ? item.error
                          ? `Error: ${item.error}`
                          : item.layer === 'strategy'
                            ? agentName(item) === 'REGIME_CLASSIFIER' ? `${item.regime || '?'} (${item.confidence || 0}%)`
                            : agentName(item) === 'SYNTHESIZER' ? `${item.proposals || 0} proposals${item.standing_orders ? `, ${item.standing_orders} standing orders` : ''}`
                            : `${item.approved || 0} approved, ${item.rejected || 0} rejected`
                          : `${item.signals_count || 0} signals`
                        : item.error
                          ? `Error: ${item.error}`
                          : item.type === 'trades_executed'
                            ? `${item.trades?.length || 0} trade(s) executed`
                          : item.type === 'positions_closed'
                            ? `${item.count || 0} position(s) closed`
                          : item.type === 'standing_order_triggered'
                            ? `${item.symbol} ${item.side} @ ${Number(item.fill_price || 0).toFixed(0)}`
                          : item.type === 'position_review'
                            ? `${item.summary || 'Positions reviewed'}`
                          : item.type === 'trade' || item.type === 'trade_closed'
                            ? `${item.symbol || ''} ${item.side || ''} ${item.type === 'trade_closed' ? 'closed' : 'opened'}`
                          : item.type === 'scram_activated'
                            ? `${item.level || 'EMERGENCY'} \u2014 all risk suspended`
                          : item.type === 'scram_cleared'
                            ? 'Risk controls restored'
                          : item.type === 'analysis_complete'
                            ? 'Analysis cycle complete'
                          : item.description || `${item.signals_count || item.signals || 0} signals`
                }
              </span>
            </div>
            <div className="v2-feed-right">
              {(item.cost_usd > 0 || item.cost > 0) && (
                <span className="v2-feed-cost">${Number(item.cost_usd || item.cost || 0).toFixed(2)}</span>
              )}
              <span className="v2-feed-time">{timeAgo(item.ts)}</span>
            </div>
          </div>
        ))}
      </div>

      <style>{`
        .v2-agent-feed { max-height: 500px; overflow-y: auto; }
        .v2-feed-title {
          font-family: var(--v2-font-data); font-size: 11px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1.5px; color: var(--v2-text-muted);
          margin-bottom: var(--v2-space-md);
        }
        .v2-feed-list { display: flex; flex-direction: column; gap: 1px; }
        .v2-feed-empty { color: var(--v2-text-muted); font-size: 13px; padding: var(--v2-space-lg); text-align: center; }
        .v2-feed-item {
          display: flex; justify-content: space-between; align-items: center;
          padding: var(--v2-space-sm) var(--v2-space-md);
          border-left: 2px solid var(--v2-accent-magenta);
          background: rgba(179,157,219,0.03);
          transition: background var(--v2-duration-fast);
        }
        .v2-feed-item:hover { background: rgba(179,157,219,0.06); }
        .v2-feed-left { display: flex; align-items: center; gap: var(--v2-space-md); }
        .v2-feed-right { display: flex; align-items: center; gap: var(--v2-space-sm); }
        .v2-feed-agent {
          font-family: var(--v2-font-data); font-weight: 600; font-size: 10px;
          color: var(--v2-accent-magenta); text-transform: uppercase; min-width: 100px;
        }
        .v2-feed-agent--system { color: var(--v2-accent-cyan); }
        .v2-feed-text {
          font-family: var(--v2-font-body); font-weight: 300; font-size: 13px;
          color: var(--v2-text-secondary);
        }
        .v2-feed-cost {
          font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-text-muted);
        }
        .v2-feed-time {
          font-family: var(--v2-font-data); font-size: 10px;
          color: var(--v2-text-muted); white-space: nowrap;
        }

        /* Cycle progress */
        .v2-cycle-progress {
          padding: var(--v2-space-md);
          border-bottom: 1px solid var(--v2-border);
          margin-bottom: var(--v2-space-sm);
        }
        .v2-cycle-header {
          display: flex; justify-content: space-between; margin-bottom: var(--v2-space-xs);
        }
        .v2-cycle-label {
          display: flex; align-items: center; gap: var(--v2-space-sm);
          font-family: var(--v2-font-data); font-size: 11px; font-weight: 600;
          color: var(--v2-accent-cyan); text-transform: uppercase; letter-spacing: 1px;
        }
        .v2-cycle-count {
          font-family: var(--v2-font-data); font-size: 11px; color: var(--v2-text-muted);
        }
        .v2-cycle-bar {
          height: 3px; background: var(--v2-border); border-radius: 2px;
          margin-bottom: var(--v2-space-sm); overflow: hidden;
        }
        .v2-cycle-fill {
          height: 100%; background: var(--v2-accent-cyan);
          border-radius: 2px; transition: width 0.4s var(--v2-ease-out);
        }
        .v2-cycle-chips { display: flex; flex-wrap: wrap; gap: 4px; }
        .v2-chip {
          display: flex; align-items: center; gap: 4px;
          padding: 2px 8px; border-radius: var(--v2-radius-sm);
          font-family: var(--v2-font-data); font-size: 10px;
          border: 1px solid var(--v2-border-hover); color: var(--v2-text-muted);
          transition: all var(--v2-duration-normal);
        }
        .v2-chip--done {
          border-color: var(--v2-accent-cyan); color: var(--v2-accent-cyan);
          background: rgba(79,195,247,0.05);
        }
        .v2-chip--error {
          border-color: var(--v2-accent-red); color: var(--v2-accent-red);
          background: rgba(239,83,80,0.05);
        }
        .v2-chip--strategy { border-style: dashed; }
        .v2-chip--strategy.v2-chip--done {
          border-style: solid; border-color: var(--v2-accent-magenta);
          color: var(--v2-accent-magenta); background: rgba(179,157,219,0.05);
        }
        .v2-chip-name { text-transform: uppercase; }
        .v2-chip-count { font-weight: 700; }
        .v2-chip-err { font-weight: 700; color: var(--v2-accent-red); }
        .v2-chip--pending .v2-chip-name { opacity: 0.5; }
        .v2-chip--pending { animation: v2-status-pulse 2s ease-in-out infinite; }
      `}</style>
    </div>
  );
}
