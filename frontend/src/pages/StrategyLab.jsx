import { useEffect } from 'react';
import { useDataStore } from '../stores/data';
import { timeAgo, formatPct } from '../lib/format';

export default function StrategyLab() {
  const { fetchTemplates, fetchLearnings, fetchStandingOrders, templates, antiPatterns, learnings, learningsSummary, standingOrders } = useDataStore();

  useEffect(() => { fetchTemplates(); fetchLearnings(); fetchStandingOrders(); }, []);

  return (
    <div className="strategy-page">
      <div className="page-header">
        <h1 className="page-title">STRATEGY LAB</h1>
      </div>

      {/* Templates */}
      <div className="panel">
        <div className="panel-title">Strategy Templates ({templates.length})</div>
        {templates.length === 0 ? (
          <div className="empty-state">No templates yet. Run analysis to discover patterns.</div>
        ) : (
          <div className="template-grid">
            {templates.map((t, i) => (
              <div key={i} className="template-card">
                <div className="template-header">
                  <span className="template-name">{t.name}</span>
                  <span className={`badge badge-${t.status}`}>{t.status}</span>
                </div>
                <div className="template-desc">{t.description || 'No description'}</div>
                <div className="template-stats">
                  <span className="num">{t.trade_count || 0} trades</span>
                  {t.valid_regimes && (
                    <span className="template-regimes">
                      {(Array.isArray(t.valid_regimes) ? t.valid_regimes : []).join(', ')}
                    </span>
                  )}
                </div>
                <div className="template-meta">
                  <span className="template-source">{t.source || 'manual'}</span>
                  <span className="template-time">{timeAgo(t.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Standing Orders */}
      <div className="panel">
        <div className="panel-title">Standing Orders ({standingOrders.length})</div>
        {standingOrders.length === 0 ? (
          <div className="empty-state">No standing orders. Synthesizer creates these during cycles.</div>
        ) : (
          <div className="so-table">
            <div className="so-header-row">
              <span className="so-col so-col-symbol">Symbol</span>
              <span className="so-col so-col-conditions">Trigger Conditions</span>
              <span className="so-col so-col-template">Template</span>
              <span className="so-col so-col-conf">Conf</span>
              <span className="so-col so-col-expires">Expires</span>
              <span className="so-col so-col-status">Status</span>
            </div>
            {standingOrders.map((o) => {
              let cond = {};
              try { cond = typeof o.conditions === 'string' ? JSON.parse(o.conditions) : (o.conditions || {}); } catch { /* malformed JSON */ }
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
                : cond.entry_trigger || cond.logic || '—';

              // expires_at is a future timestamp — show "in Xh/Xd" not "Xs ago"
              let expiresText = '—';
              if (o.expires_at) {
                const diff = Math.floor((new Date(o.expires_at).getTime() - Date.now()) / 1000);
                if (diff <= 0) {
                  expiresText = 'expired';
                } else if (diff < 3600) {
                  expiresText = `in ${Math.floor(diff / 60)}m`;
                } else if (diff < 86400) {
                  expiresText = `in ${Math.floor(diff / 3600)}h`;
                } else {
                  expiresText = `in ${Math.floor(diff / 86400)}d`;
                }
              }

              return (
                <div key={o.id} className="so-row">
                  <span className="so-col so-col-symbol">
                    <span className="so-symbol">{o.symbol}</span>
                    <span className={`badge badge-${o.side === 'buy' ? 'profit' : 'loss'}`}>{o.side}</span>
                  </span>
                  <span className="so-col so-col-conditions so-conditions-text">{condText}</span>
                  <span className="so-col so-col-template">{o.template_id ? `#${o.template_id}` : '—'}</span>
                  <span className="so-col so-col-conf num">{o.confidence != null ? `${o.confidence}%` : '—'}</span>
                  <span className="so-col so-col-expires">{expiresText}</span>
                  <span className="so-col so-col-status">
                    <span className={`badge badge-so-${o.status || 'active'}`}>{o.status || 'active'}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="two-col">
        {/* Anti-Patterns */}
        <div className="panel">
          <div className="panel-title">Anti-Patterns ({antiPatterns.length})</div>
          {antiPatterns.length === 0 ? (
            <div className="empty-state">No anti-patterns identified</div>
          ) : antiPatterns.map((ap, i) => (
            <div key={i} className="ap-row">
              <div className="ap-header">
                <span className="ap-name">{ap.name}</span>
                <span className="badge badge-loss">{ap.lose_rate}% lose</span>
              </div>
              <div className="ap-signals">
                {(Array.isArray(ap.signal_combination) ? ap.signal_combination : []).map((s, j) => (
                  <span key={j} className="badge badge-neutral">{s}</span>
                ))}
              </div>
              {ap.description && <div className="ap-desc">{ap.description}</div>}
              <div className="ap-meta">
                <span className="num">{ap.sample_size} trades</span>
              </div>
            </div>
          ))}
        </div>

        {/* Learnings Summary */}
        <div className="panel">
          <div className="panel-title">Learning Categories</div>
          {learningsSummary.length === 0 ? (
            <div className="empty-state">No learnings yet</div>
          ) : learningsSummary.map((cat, i) => (
            <div key={i} className="cat-row">
              <span className="cat-name">{cat.category}</span>
              <span className="num cat-count">{cat.active_count}</span>
              <div className="cat-confidence">
                {cat.high_confidence > 0 && <span className="badge badge-profit">{cat.high_confidence} high</span>}
                {cat.med_confidence > 0 && <span className="badge badge-warn">{cat.med_confidence} med</span>}
                {cat.low_confidence > 0 && <span className="badge badge-neutral">{cat.low_confidence} low</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Learnings Feed */}
      <div className="panel">
        <div className="panel-title">Recent Learnings ({learnings.length})</div>
        {learnings.length === 0 ? (
          <div className="empty-state">No learnings extracted yet. Run analysis after some trades.</div>
        ) : (
          <div className="learnings-list">
            {learnings.map((l, i) => (
              <div key={i} className="learning-item">
                <div className="learning-header">
                  <span className={`badge badge-${l.confidence === 'high' ? 'profit' : l.confidence === 'med' ? 'warn' : 'neutral'}`}>
                    {l.confidence}
                  </span>
                  <span className="badge badge-ai">{l.category}</span>
                  <span className="learning-source">{l.source_agent}</span>
                  <span className="learning-time">{timeAgo(l.created_at)}</span>
                </div>
                <div className="learning-text">{l.insight_text}</div>
                {l.symbols && Array.isArray(l.symbols) && l.symbols.length > 0 && (
                  <div className="learning-symbols">
                    {l.symbols.map((s, j) => <span key={j} className="badge badge-neutral">{s}</span>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`
        .strategy-page { display: flex; flex-direction: column; gap: var(--space-lg); }
        .page-header { display: flex; justify-content: space-between; align-items: center; }
        .page-title {
          font-family: 'Syne', sans-serif; font-weight: 800; font-size: 18px;
          letter-spacing: 6px; color: var(--t2);
        }
        .template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-md); }
        .template-card {
          background: var(--elevated); border: 1px solid var(--border-0);
          border-radius: var(--radius-sm); padding: var(--space-lg);
        }
        .template-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-sm); }
        .template-name {
          font-family: 'Instrument Sans', sans-serif; font-weight: 600;
          font-size: 14px; color: var(--t1);
        }
        .template-desc { color: var(--t3); font-size: 12px; margin-bottom: var(--space-sm); }
        .template-stats {
          display: flex; gap: var(--space-sm); align-items: center;
          font-size: 11px; color: var(--t3); margin-bottom: var(--space-xs);
        }
        .template-regimes { color: var(--t4); font-size: 10px; }
        .template-meta {
          display: flex; justify-content: space-between;
          font-size: 10px; color: var(--t4);
        }
        .template-source {
          font-family: 'IBM Plex Mono', monospace; text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--panel-gap); }
        .empty-state { color: var(--t4); font-size: 13px; padding: var(--space-xl); text-align: center; }
        .ap-row {
          padding: var(--space-sm) 0;
          border-bottom: 1px solid var(--border-0);
        }
        .ap-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-xs); }
        .ap-name { font-family: 'Instrument Sans', sans-serif; font-weight: 500; font-size: 13px; }
        .ap-signals { display: flex; gap: var(--space-xs); flex-wrap: wrap; margin-bottom: var(--space-xs); }
        .ap-desc { color: var(--t3); font-size: 11px; margin-bottom: var(--space-xs); }
        .ap-meta { font-size: 10px; color: var(--t4); }
        .cat-row {
          display: flex; align-items: center; gap: var(--space-md);
          padding: var(--space-sm) 0; border-bottom: 1px solid var(--border-0);
        }
        .cat-name {
          font-family: 'Instrument Sans', sans-serif; font-weight: 500;
          font-size: 13px; flex: 1;
        }
        .cat-count { font-size: 14px; min-width: 30px; }
        .cat-confidence { display: flex; gap: var(--space-xs); }
        .learnings-list { display: flex; flex-direction: column; gap: var(--space-sm); }
        .learning-item {
          border-left: 2px solid var(--ai);
          padding: var(--space-sm) var(--space-md);
          background: rgba(167,139,250,0.03);
        }
        .learning-header {
          display: flex; align-items: center; gap: var(--space-sm);
          margin-bottom: var(--space-xs);
        }
        .learning-source {
          font-family: 'IBM Plex Mono', monospace; font-size: 9px;
          color: var(--t4); text-transform: uppercase;
        }
        .learning-time { font-size: 10px; color: var(--t4); margin-left: auto; }
        .learning-text { font-size: 13px; color: var(--t2); line-height: 1.4; }
        .learning-symbols { display: flex; gap: var(--space-xs); margin-top: var(--space-xs); }

        /* Standing Orders */
        .so-table { display: flex; flex-direction: column; }
        .so-header-row {
          display: flex; align-items: center; gap: var(--space-sm);
          padding: var(--space-xs) var(--space-md);
          border-bottom: 1px solid var(--border-1);
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px; font-weight: 600;
          color: var(--t4); text-transform: uppercase; letter-spacing: 0.5px;
        }
        .so-row {
          display: flex; align-items: center; gap: var(--space-sm);
          padding: var(--space-sm) var(--space-md);
          border-bottom: 1px solid var(--border-0);
          transition: background var(--transition-fast);
        }
        .so-row:hover { background: rgba(0,255,255,0.03); }
        .so-col-symbol { flex: 0 0 140px; display: flex; align-items: center; gap: var(--space-xs); }
        .so-symbol {
          font-family: 'IBM Plex Mono', monospace; font-weight: 600;
          font-size: 13px; color: var(--t1);
        }
        .so-col-conditions { flex: 1; min-width: 0; }
        .so-conditions-text {
          font-size: 12px; color: var(--t3);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .so-col-template {
          flex: 0 0 70px; font-family: 'IBM Plex Mono', monospace;
          font-size: 11px; color: var(--t3);
        }
        .so-col-conf {
          flex: 0 0 50px; font-family: 'IBM Plex Mono', monospace;
          font-size: 12px; text-align: right;
        }
        .so-col-expires {
          flex: 0 0 70px; font-family: 'IBM Plex Mono', monospace;
          font-size: 10px; color: var(--t4); text-align: right;
        }
        .so-col-status { flex: 0 0 80px; text-align: right; }
        .badge-so-active { background: rgba(0,255,255,0.1); color: var(--cyan); border: 1px solid rgba(0,255,255,0.3); }
        .badge-so-triggered { background: rgba(167,139,250,0.1); color: var(--ai); border: 1px solid rgba(167,139,250,0.3); }
        .badge-so-expired { background: rgba(255,255,255,0.05); color: var(--t4); border: 1px solid var(--border-1); }
        .badge-so-cancelled { background: rgba(255,255,255,0.05); color: var(--t4); border: 1px solid var(--border-1); }
        .badge-so-filled { background: rgba(0,200,100,0.1); color: var(--profit); border: 1px solid rgba(0,200,100,0.3); }
      `}</style>
    </div>
  );
}
