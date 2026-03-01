import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const IMPACT_COLORS = {
  low: 'neutral', medium: 'warn', high: 'loss', critical: 'loss',
};

export default function EventCalendar() {
  const [events, setEvents] = useState([]);
  const [blackout, setBlackout] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    event_type: 'economic', event_name: '', event_date: '', impact_estimate: 'medium',
  });

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const [ev, bo] = await Promise.all([api('/events'), api('/events/blackout')]);
      setEvents(ev || []);
      setBlackout(bo);
    } catch {}
  }

  async function createEvent() {
    try {
      await api('/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      setShowForm(false);
      setForm({ event_type: 'economic', event_name: '', event_date: '', impact_estimate: 'medium' });
      load();
    } catch (err) { console.error('Create event failed:', err); }
  }

  async function deleteEvent(id) {
    try {
      await api(`/events/${id}`, { method: 'DELETE' });
      load();
    } catch {}
  }

  const now = new Date();

  return (
    <div className="panel event-calendar">
      <div className="ec-header">
        <span className="panel-title">
          Events
          {blackout?.in_blackout && (
            <span className="badge badge-loss" style={{ marginLeft: 8 }}>BLACKOUT</span>
          )}
        </span>
        <button className="ec-add" onClick={() => setShowForm(!showForm)}>
          {showForm ? '×' : '+'}
        </button>
      </div>

      {showForm && (
        <div className="ec-form">
          <select value={form.event_type} onChange={e => setForm(f => ({ ...f, event_type: e.target.value }))}>
            <option value="economic">Economic</option>
            <option value="fed">Fed/FOMC</option>
            <option value="crypto">Crypto</option>
            <option value="earnings">Earnings</option>
            <option value="other">Other</option>
          </select>
          <input placeholder="Event name" value={form.event_name}
            onChange={e => setForm(f => ({ ...f, event_name: e.target.value }))} />
          <input type="datetime-local" value={form.event_date}
            onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))} />
          <select value={form.impact_estimate} onChange={e => setForm(f => ({ ...f, impact_estimate: e.target.value }))}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
          <button className="ec-submit" onClick={createEvent}>Add</button>
        </div>
      )}

      {events.length === 0 ? (
        <div className="empty-state" style={{ padding: '12px' }}>No upcoming events</div>
      ) : (
        <div className="ec-list">
          {events.slice(0, 8).map((e, i) => {
            const eventDate = new Date(e.event_date);
            const isBlackout = e.blackout_start && e.blackout_end &&
              now >= new Date(e.blackout_start) && now <= new Date(e.blackout_end);
            const isPast = eventDate < now;

            return (
              <div key={i} className={`ec-row ${isBlackout ? 'ec-blackout' : ''} ${isPast ? 'ec-past' : ''}`}>
                <div className="ec-date-col">
                  <span className="ec-day">{eventDate.getDate()}</span>
                  <span className="ec-month">{eventDate.toLocaleString('default', { month: 'short' })}</span>
                </div>
                <div className="ec-info">
                  <span className="ec-name">{e.event_name}</span>
                  <span className="ec-meta">
                    <span className={`badge badge-${IMPACT_COLORS[e.impact_estimate]}`}>{e.impact_estimate}</span>
                    <span className="ec-type">{e.event_type}</span>
                    <span className="ec-time">{eventDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </span>
                </div>
                <button className="ec-delete" onClick={() => deleteEvent(e.id)}>×</button>
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        .ec-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-sm); }
        .ec-header .panel-title { margin-bottom: 0; }
        .ec-add {
          font-size: 18px; color: var(--t3); width: 24px; height: 24px;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; transition: color var(--transition-fast);
        }
        .ec-add:hover { color: var(--cyan); }
        .ec-form {
          display: flex; gap: var(--space-xs); flex-wrap: wrap; align-items: center;
          padding: var(--space-sm) 0; border-bottom: 1px solid var(--border-0);
          margin-bottom: var(--space-sm);
        }
        .ec-form input, .ec-form select { font-size: 11px; padding: 4px 6px; max-width: 140px; }
        .ec-submit {
          font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 600;
          color: var(--cyan); cursor: pointer; padding: 4px 8px;
          border: 1px solid var(--cyan); border-radius: var(--radius-sm);
        }
        .ec-row {
          display: flex; align-items: center; gap: var(--space-sm);
          padding: var(--space-xs) 0; border-bottom: 1px solid var(--border-0);
        }
        .ec-row.ec-blackout { background: rgba(255,45,85,0.05); border-left: 2px solid var(--red); padding-left: var(--space-sm); }
        .ec-row.ec-past { opacity: 0.5; }
        .ec-date-col {
          display: flex; flex-direction: column; align-items: center;
          min-width: 36px;
        }
        .ec-day { font-family: 'IBM Plex Mono', monospace; font-size: 16px; font-weight: 500; line-height: 1; }
        .ec-month { font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: var(--t4); text-transform: uppercase; }
        .ec-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
        .ec-name { font-size: 12px; color: var(--t1); }
        .ec-meta { display: flex; align-items: center; gap: var(--space-xs); }
        .ec-type { font-size: 9px; color: var(--t4); text-transform: uppercase; }
        .ec-time { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: var(--t3); }
        .ec-delete {
          font-size: 14px; color: var(--t4); cursor: pointer;
          transition: color var(--transition-fast); opacity: 0;
        }
        .ec-row:hover .ec-delete { opacity: 1; }
        .ec-delete:hover { color: var(--red); }
      `}</style>
    </div>
  );
}
