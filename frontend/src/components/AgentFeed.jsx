import { useDataStore } from '../stores/data';
import { timeAgo } from '../lib/format';

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

  // Use WS feed only if it has meaningful content (not just system connect messages)
  const meaningfulWsItems = wsItems.filter(item =>
    item.type !== 'system' || wsItems.some(i => i.type === 'agent_complete' || i.type === 'cycle_complete')
  );

  const items = meaningfulWsItems.length > 0 ? wsItems : decisionItems;

  return (
    <div className="panel agent-feed">
      <div className="panel-title">Agent Activity</div>

      {/* Live cycle progress bar */}
      {cycleStatus?.running && (
        <div className="cycle-progress">
          <div className="cycle-progress-header">
            <span className="cycle-progress-label">Cycle {cycleStatus.cycleNumber}</span>
            <span className="cycle-progress-count">{cycleStatus.completed.length} / {cycleStatus.agents.length + 3}</span>
          </div>
          <div className="cycle-progress-bar">
            <div
              className="cycle-progress-fill"
              style={{ width: `${(cycleStatus.completed.length / (cycleStatus.agents.length + 3)) * 100}%` }}
            />
          </div>
          <div className="cycle-agents-grid">
            {cycleStatus.agents.map(name => {
              const done = cycleStatus.completed.find(c => c.agent_name === name);
              return (
                <div key={name} className={`cycle-agent-chip ${done ? (done.error ? 'error' : 'done') : 'pending'}`}>
                  <span className="chip-name">{name}</span>
                  {done && !done.error && <span className="chip-signals">{done.signals_count}</span>}
                  {done?.error && <span className="chip-err">!</span>}
                </div>
              );
            })}
            {['regime_classifier', 'synthesizer', 'risk_manager'].map(name => {
              const done = cycleStatus.completed.find(c => c.agent_name === name);
              return (
                <div key={name} className={`cycle-agent-chip strategy ${done ? (done.error ? 'error' : 'done') : 'pending'}`}>
                  <span className="chip-name">{name.replace('_', ' ').replace('regime classifier', 'regime')}</span>
                  {done && !done.error && (
                    <span className="chip-signals">
                      {name === 'regime_classifier'
                        ? done.regime
                        : name === 'synthesizer'
                          ? `${done.proposals}p${done.standing_orders ? ` +${done.standing_orders}so` : ''}`
                          : `${done.approved}ok`}
                    </span>
                  )}
                  {done?.error && <span className="chip-err">!</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="feed-list">
        {items.length === 0 && !cycleStatus?.running && (
          <div className="feed-empty">No activity yet. Trigger a cycle to start.</div>
        )}
        {items.map((item, i) => (
          <div key={i} className="feed-item">
            <div className="feed-left">
              {item.type === 'system' ? (
                <span className="feed-agent" style={{ color: 'var(--cyan)' }}>SYSTEM</span>
              ) : item.type === 'cycle_start' || item.type === 'cycle_complete' ? (
                <span className="feed-agent" style={{ color: 'var(--cyan)' }}>CYCLE</span>
              ) : (
                <span className="feed-agent">{agentName(item)}</span>
              )}
              <span className="feed-text">
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
                            ? `${item.level || 'EMERGENCY'} — all risk suspended`
                          : item.type === 'scram_cleared'
                            ? 'Risk controls restored'
                          : item.type === 'analysis_complete'
                            ? 'Analysis cycle complete'
                          : item.description || `${item.signals_count || item.signals || 0} signals`
                }
              </span>
            </div>
            <div className="feed-right">
              {(item.cost_usd > 0 || item.cost > 0) && (
                <span className="feed-cost">${Number(item.cost_usd || item.cost || 0).toFixed(2)}</span>
              )}
              <span className="feed-time">{timeAgo(item.ts)}</span>
            </div>
          </div>
        ))}
      </div>

      <style>{`
        .agent-feed { max-height: 500px; overflow-y: auto; }
        .feed-list { display: flex; flex-direction: column; gap: 1px; }
        .feed-empty { color: var(--t4); font-size: 13px; padding: var(--space-lg); text-align: center; }
        .feed-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--space-sm) var(--space-md);
          border-left: 2px solid var(--ai);
          background: rgba(167,139,250,0.03);
          transition: background var(--transition-fast);
        }
        .feed-item:hover { background: rgba(167,139,250,0.06); }
        .feed-left { display: flex; align-items: center; gap: var(--space-md); }
        .feed-right { display: flex; align-items: center; gap: var(--space-sm); }
        .feed-agent {
          font-family: 'IBM Plex Mono', monospace;
          font-weight: 600;
          font-size: 10px;
          color: var(--ai);
          text-transform: uppercase;
          min-width: 100px;
        }
        .feed-text {
          font-family: 'Outfit', sans-serif;
          font-weight: 300;
          font-size: 13px;
          color: var(--t2);
        }
        .feed-cost {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          color: var(--t3);
        }
        .feed-time {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          color: var(--t4);
          white-space: nowrap;
        }

        /* Cycle progress */
        .cycle-progress {
          padding: var(--space-md);
          border-bottom: 1px solid var(--border-1);
        }
        .cycle-progress-header {
          display: flex;
          justify-content: space-between;
          margin-bottom: var(--space-xs);
        }
        .cycle-progress-label {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          font-weight: 600;
          color: var(--cyan);
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        .cycle-progress-count {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: var(--t3);
        }
        .cycle-progress-bar {
          height: 3px;
          background: var(--border-1);
          border-radius: 2px;
          margin-bottom: var(--space-sm);
          overflow: hidden;
        }
        .cycle-progress-fill {
          height: 100%;
          background: var(--cyan);
          border-radius: 2px;
          transition: width 0.4s ease;
        }
        .cycle-agents-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }
        .cycle-agent-chip {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 2px 8px;
          border-radius: 3px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          border: 1px solid var(--border-2);
          color: var(--t4);
          transition: all 0.3s ease;
        }
        .cycle-agent-chip.done {
          border-color: var(--cyan);
          color: var(--cyan);
          background: rgba(0,255,255,0.05);
        }
        .cycle-agent-chip.error {
          border-color: var(--loss);
          color: var(--loss);
          background: rgba(255,0,0,0.05);
        }
        .cycle-agent-chip.strategy { border-style: dashed; }
        .cycle-agent-chip.strategy.done { border-style: solid; border-color: var(--ai); color: var(--ai); background: rgba(167,139,250,0.05); }
        .chip-name { text-transform: uppercase; }
        .chip-signals { font-weight: 700; }
        .chip-err { font-weight: 700; color: var(--loss); }
        .cycle-agent-chip.pending .chip-name { opacity: 0.5; }

        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
        .cycle-agent-chip.pending { animation: pulse 2s ease-in-out infinite; }
      `}</style>
    </div>
  );
}
