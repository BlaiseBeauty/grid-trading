import { useEffect, useState } from 'react';
import { useDataStore } from '../stores/data';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { GlowCard, SignalBadge, StatusPulse, CountdownTimer, RangeBar } from '../components/ui';

export default function StrategyLab() {
  const { fetchTemplates, fetchLearnings, fetchStandingOrders, templates, antiPatterns, learnings, learningsSummary, standingOrders, prices } = useDataStore();
  const [cancellingId, setCancellingId] = useState(null);

  useEffect(() => { fetchTemplates(); fetchLearnings(); fetchStandingOrders(); }, []);

  async function cancelOrder(id) {
    if (!confirm('Cancel this standing order?')) return;
    setCancellingId(id);
    try {
      await api(`/standing-orders/${id}/cancel`, { method: 'PATCH', body: JSON.stringify({ reason: 'manual' }), headers: { 'Content-Type': 'application/json' } });
      fetchStandingOrders();
    } catch (e) {
      console.error('Cancel failed:', e);
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div className="v2-strategy-page">
      <h1 className="v2-page-title v2-animate-in">STRATEGY LAB</h1>

      {/* Standing Orders */}
      <div className="v2-animate-in v2-stagger-1">
        <GlowCard glowColor="cyan">
          <div className="v2-section-title">Standing Orders ({standingOrders.length})</div>
          {standingOrders.length === 0 ? (
            <div className="v2-empty">No standing orders. Synthesizer creates these during cycles.</div>
          ) : (
            <div className="v2-so-grid">
              {standingOrders.map((o, i) => {
                let cond = {};
                try { cond = typeof o.conditions === 'string' ? JSON.parse(o.conditions) : (o.conditions || {}); } catch {}
                const priceKeys = ['price_below', 'price_above', 'price', 'entry_price', 'price_level'];
                let triggerPrice = null;
                let triggerLabel = null;
                for (const k of priceKeys) {
                  const v = cond[k];
                  if (v != null && typeof v === 'number') {
                    triggerLabel = k.replace('price_', '').replace('price', 'at');
                    triggerPrice = v;
                    break;
                  }
                }
                const condText = triggerPrice
                  ? `${triggerLabel} $${Number(triggerPrice).toLocaleString()}`
                  : cond.entry_trigger || cond.logic || '\u2014';

                const currentPrice = prices[o.symbol]?.price;
                const isExpired = o.expires_at && new Date(o.expires_at).getTime() <= Date.now();
                const isActive = o.status === 'active' && !isExpired;

                // Build RangeBar bounds: use trigger price as target, current as position
                let rangeLow = null, rangeHigh = null;
                if (triggerPrice && currentPrice) {
                  if (o.side === 'buy') {
                    // Buy order triggers when price drops to trigger
                    rangeLow = triggerPrice * 0.95;
                    rangeHigh = currentPrice > triggerPrice ? currentPrice * 1.02 : triggerPrice * 1.05;
                  } else {
                    // Sell order triggers when price rises to trigger
                    rangeLow = currentPrice < triggerPrice ? currentPrice * 0.98 : triggerPrice * 0.95;
                    rangeHigh = triggerPrice * 1.05;
                  }
                }

                return (
                  <div key={o.id} className={`v2-so-card v2-animate-in v2-stagger-${Math.min(i + 1, 8)}`}>
                    <GlowCard>
                      <div className="v2-so-card-top">
                        <div className="v2-so-card-left">
                          <span className="v2-so-symbol">{o.symbol}</span>
                          <SignalBadge direction={o.side === 'buy' ? 'long' : 'short'} />
                        </div>
                        <div className="v2-so-card-right">
                          <StatusPulse
                            status={isActive ? 'active' : o.status === 'triggered' ? 'warning' : 'idle'}
                            size={6}
                            label={o.status || 'active'}
                          />
                        </div>
                      </div>

                      <div className="v2-so-card-row">
                        <span className="v2-so-label">Confidence</span>
                        <span className="v2-so-value">{o.confidence != null ? `${o.confidence}%` : '\u2014'}</span>
                      </div>

                      <div className="v2-so-card-row">
                        <span className="v2-so-label">Trigger</span>
                        <span className="v2-so-value">{condText}</span>
                      </div>

                      {triggerPrice && currentPrice && rangeLow && rangeHigh && (
                        <div className="v2-so-range-wrap">
                          <RangeBar
                            current={currentPrice}
                            low={rangeLow}
                            high={rangeHigh}
                            side={o.side || 'buy'}
                          />
                          <div className="v2-so-proximity">
                            {Math.abs(((currentPrice - triggerPrice) / triggerPrice) * 100).toFixed(1)}% away
                          </div>
                        </div>
                      )}

                      <div className="v2-so-card-row">
                        <span className="v2-so-label">Expires</span>
                        <span className="v2-so-value">
                          {o.expires_at ? (
                            isExpired
                              ? <span className="v2-so-expired">Expired</span>
                              : <CountdownTimer targetTime={new Date(o.expires_at)} />
                          ) : '\u2014'}
                        </span>
                      </div>

                      {o.template_id && (
                        <div className="v2-so-card-row">
                          <span className="v2-so-label">Template</span>
                          <span className="v2-so-value v2-tag">#{o.template_id}</span>
                        </div>
                      )}

                      {isActive && (
                        <button
                          className="v2-so-cancel-btn"
                          onClick={() => cancelOrder(o.id)}
                          disabled={cancellingId === o.id}
                        >
                          {cancellingId === o.id ? 'Cancelling...' : 'Cancel Order'}
                        </button>
                      )}
                    </GlowCard>
                  </div>
                );
              })}
            </div>
          )}
        </GlowCard>
      </div>

      {/* Templates */}
      <div className="v2-animate-in v2-stagger-2">
        <GlowCard>
          <div className="v2-section-title">Strategy Templates ({templates.length})</div>
          {templates.length === 0 ? (
            <div className="v2-empty">No templates yet. Run analysis to discover patterns.</div>
          ) : (
            <div className="v2-template-grid">
              {templates.map((t, i) => (
                <div key={i} className={`v2-template-card v2-animate-in v2-stagger-${Math.min(i + 1, 8)}`}>
                  <div className="v2-template-header">
                    <span className="v2-template-name">{t.name}</span>
                    <StatusPulse
                      status={t.status === 'active' ? 'active' : t.status === 'testing' ? 'warning' : 'idle'}
                      size={6}
                      label={t.status}
                    />
                  </div>
                  <div className="v2-template-desc">{t.description || 'No description'}</div>
                  <div className="v2-template-stats">
                    <span className="v2-mono">{t.trade_count || 0} trades</span>
                    {t.valid_regimes && (
                      <span className="v2-template-regimes">
                        {(Array.isArray(t.valid_regimes) ? t.valid_regimes : []).join(', ')}
                      </span>
                    )}
                  </div>
                  <div className="v2-template-meta">
                    <span className="v2-template-source">{t.source || 'manual'}</span>
                    <span className="v2-template-time">{timeAgo(t.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </GlowCard>
      </div>

      <div className="v2-two-col v2-animate-in v2-stagger-3">
        {/* Anti-Patterns */}
        <GlowCard glowColor="red">
          <div className="v2-section-title">Anti-Patterns ({antiPatterns.length})</div>
          {antiPatterns.length === 0 ? (
            <div className="v2-empty">No anti-patterns identified</div>
          ) : antiPatterns.map((ap, i) => (
            <div key={i} className="v2-ap-row">
              <div className="v2-ap-header">
                <span className="v2-ap-name">{ap.name}</span>
                <span className="v2-ap-lose">{ap.lose_rate}% lose</span>
              </div>
              <div className="v2-ap-signals">
                {(Array.isArray(ap.signal_combination) ? ap.signal_combination : []).map((s, j) => (
                  <span key={j} className="v2-tag">{s}</span>
                ))}
              </div>
              {ap.description && <div className="v2-ap-desc">{ap.description}</div>}
              <div className="v2-ap-meta">
                <span className="v2-mono">{ap.sample_size} trades</span>
              </div>
            </div>
          ))}
        </GlowCard>

        {/* Learning Categories */}
        <GlowCard glowColor="amber">
          <div className="v2-section-title">Learning Categories</div>
          {learningsSummary.length === 0 ? (
            <div className="v2-empty">No learnings yet</div>
          ) : learningsSummary.map((cat, i) => (
            <div key={i} className="v2-cat-row">
              <span className="v2-cat-name">{cat.category}</span>
              <span className="v2-mono v2-cat-count">{cat.active_count}</span>
              <div className="v2-cat-confidence">
                {cat.high_confidence > 0 && <span className="v2-conf-badge v2-conf-high">{cat.high_confidence} high</span>}
                {cat.med_confidence > 0 && <span className="v2-conf-badge v2-conf-med">{cat.med_confidence} med</span>}
                {cat.low_confidence > 0 && <span className="v2-conf-badge v2-conf-low">{cat.low_confidence} low</span>}
              </div>
            </div>
          ))}
        </GlowCard>
      </div>

      {/* Recent Learnings */}
      <div className="v2-animate-in v2-stagger-4">
        <GlowCard>
          <div className="v2-section-title">Recent Learnings ({learnings.length})</div>
          {learnings.length === 0 ? (
            <div className="v2-empty">No learnings extracted yet. Run analysis after some trades.</div>
          ) : (
            <div className="v2-learnings-list">
              {learnings.map((l, i) => (
                <div key={i} className="v2-learning-item">
                  <div className="v2-learning-header">
                    <span className={`v2-conf-badge ${l.confidence === 'high' ? 'v2-conf-high' : l.confidence === 'med' ? 'v2-conf-med' : 'v2-conf-low'}`}>
                      {l.confidence}
                    </span>
                    <span className="v2-tag v2-tag-magenta">{l.category}</span>
                    <span className="v2-learning-source">{l.source_agent}</span>
                    <span className="v2-learning-time">{timeAgo(l.created_at)}</span>
                  </div>
                  <div className="v2-learning-text">{l.insight_text}</div>
                  {l.symbols && Array.isArray(l.symbols) && l.symbols.length > 0 && (
                    <div className="v2-learning-symbols">
                      {l.symbols.map((s, j) => <span key={j} className="v2-tag">{s}</span>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </GlowCard>
      </div>

      <style>{`
        .v2-strategy-page { display: flex; flex-direction: column; gap: var(--v2-space-lg); }
        .v2-page-title {
          font-family: 'Syne', sans-serif; font-weight: 800; font-size: 20px;
          letter-spacing: 6px; color: var(--v2-text-primary);
        }
        .v2-section-title {
          font-family: var(--v2-font-data); font-size: 11px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1.5px; color: var(--v2-text-muted);
          margin-bottom: var(--v2-space-md);
        }
        .v2-template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--v2-space-md); }
        .v2-template-card {
          background: var(--v2-bg-tertiary); border: 1px solid var(--v2-border);
          border-radius: var(--v2-radius-sm); padding: var(--v2-space-lg);
          transition: border-color var(--v2-duration-fast);
        }
        .v2-template-card:hover { border-color: var(--v2-border-hover); }
        .v2-template-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--v2-space-sm); }
        .v2-template-name {
          font-family: var(--v2-font-body); font-weight: 600;
          font-size: 14px; color: var(--v2-text-primary);
        }
        .v2-template-desc { color: var(--v2-text-secondary); font-size: 12px; margin-bottom: var(--v2-space-sm); }
        .v2-template-stats {
          display: flex; gap: var(--v2-space-sm); align-items: center;
          font-size: 11px; color: var(--v2-text-secondary); margin-bottom: var(--v2-space-xs);
        }
        .v2-template-regimes { color: var(--v2-text-muted); font-size: 10px; }
        .v2-template-meta {
          display: flex; justify-content: space-between;
          font-size: 10px; color: var(--v2-text-muted);
        }
        .v2-template-source {
          font-family: var(--v2-font-data); text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .v2-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--v2-space-lg); }
        .v2-empty { color: var(--v2-text-muted); font-size: 13px; padding: var(--v2-space-xl); text-align: center; }
        .v2-mono { font-family: var(--v2-font-data); font-variant-numeric: tabular-nums; }

        /* Tags */
        .v2-tag {
          font-family: var(--v2-font-data); font-size: 9px; font-weight: 500;
          padding: 2px 6px; border-radius: 3px;
          background: rgba(0,0,0,0.04); color: var(--v2-text-secondary);
          border: 1px solid var(--v2-border);
        }
        .v2-tag-magenta { color: var(--v2-accent-magenta); border-color: rgba(224,64,251,0.3); background: rgba(224,64,251,0.05); }

        /* Confidence badges */
        .v2-conf-badge {
          font-family: var(--v2-font-data); font-size: 9px; font-weight: 500;
          padding: 2px 6px; border-radius: 3px;
        }
        .v2-conf-high { color: var(--v2-accent-green); background: rgba(0,230,118,0.08); border: 1px solid rgba(0,230,118,0.2); }
        .v2-conf-med { color: var(--v2-accent-amber); background: rgba(255,171,0,0.08); border: 1px solid rgba(255,171,0,0.2); }
        .v2-conf-low { color: var(--v2-text-muted); background: rgba(0,0,0,0.03); border: 1px solid var(--v2-border); }

        /* Anti-patterns */
        .v2-ap-row { padding: var(--v2-space-sm) 0; border-bottom: 1px solid var(--v2-border); }
        .v2-ap-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--v2-space-xs); }
        .v2-ap-name { font-family: var(--v2-font-body); font-weight: 500; font-size: 13px; color: var(--v2-text-primary); }
        .v2-ap-lose { font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-accent-red); }
        .v2-ap-signals { display: flex; gap: var(--v2-space-xs); flex-wrap: wrap; margin-bottom: var(--v2-space-xs); }
        .v2-ap-desc { color: var(--v2-text-secondary); font-size: 11px; margin-bottom: var(--v2-space-xs); }
        .v2-ap-meta { font-size: 10px; color: var(--v2-text-muted); }

        /* Category rows */
        .v2-cat-row {
          display: flex; align-items: center; gap: var(--v2-space-md);
          padding: var(--v2-space-sm) 0; border-bottom: 1px solid var(--v2-border);
        }
        .v2-cat-name { font-family: var(--v2-font-body); font-weight: 500; font-size: 13px; flex: 1; color: var(--v2-text-primary); }
        .v2-cat-count { font-size: 14px; min-width: 30px; color: var(--v2-text-primary); }
        .v2-cat-confidence { display: flex; gap: var(--v2-space-xs); }

        /* Learnings */
        .v2-learnings-list { display: flex; flex-direction: column; gap: var(--v2-space-sm); }
        .v2-learning-item {
          border-left: 2px solid var(--v2-accent-magenta);
          padding: var(--v2-space-sm) var(--v2-space-md);
          background: rgba(224,64,251,0.03);
          border-radius: 0 var(--v2-radius-sm) var(--v2-radius-sm) 0;
        }
        .v2-learning-header {
          display: flex; align-items: center; gap: var(--v2-space-sm);
          margin-bottom: var(--v2-space-xs);
        }
        .v2-learning-source {
          font-family: var(--v2-font-data); font-size: 9px;
          color: var(--v2-text-muted); text-transform: uppercase;
        }
        .v2-learning-time { font-size: 10px; color: var(--v2-text-muted); margin-left: auto; }
        .v2-learning-text { font-size: 13px; color: var(--v2-text-secondary); line-height: 1.5; }
        .v2-learning-symbols { display: flex; gap: var(--v2-space-xs); margin-top: var(--v2-space-xs); }

        /* Standing Orders — Card Grid */
        .v2-so-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--v2-space-md); }
        .v2-so-card-top {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: var(--v2-space-md);
        }
        .v2-so-card-left { display: flex; align-items: center; gap: var(--v2-space-sm); }
        .v2-so-symbol {
          font-family: var(--v2-font-data); font-weight: 700;
          font-size: 15px; color: var(--v2-text-primary);
        }
        .v2-so-card-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: var(--v2-space-xs) 0; border-bottom: 1px solid var(--v2-border);
          font-size: 12px;
        }
        .v2-so-label {
          font-family: var(--v2-font-body); color: var(--v2-text-muted);
          text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px;
        }
        .v2-so-value {
          font-family: var(--v2-font-data); color: var(--v2-text-primary);
          font-variant-numeric: tabular-nums;
        }
        .v2-so-range-wrap {
          padding: var(--v2-space-sm) 0;
          border-bottom: 1px solid var(--v2-border);
        }
        .v2-so-proximity {
          font-family: var(--v2-font-data); font-size: 10px;
          color: var(--v2-text-muted); text-align: right;
          margin-top: 4px;
        }
        .v2-so-expired {
          font-family: var(--v2-font-data); font-size: 11px;
          color: var(--v2-accent-red); font-weight: 500;
        }
        .v2-so-cancel-btn {
          width: 100%; margin-top: var(--v2-space-md);
          padding: var(--v2-space-sm) var(--v2-space-md);
          border: 1px solid rgba(255,23,68,0.3); border-radius: var(--v2-radius-sm);
          background: transparent; color: var(--v2-accent-red);
          font-family: var(--v2-font-data); font-size: 10px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1px;
          cursor: pointer; transition: all var(--v2-duration-fast);
        }
        .v2-so-cancel-btn:hover {
          background: rgba(255,23,68,0.08);
          border-color: var(--v2-accent-red);
        }
        .v2-so-cancel-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        @media (max-width: 900px) {
          .v2-two-col { grid-template-columns: 1fr; }
          .v2-so-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
