import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { StatusPulse } from './ui';

const IMPACT_COLORS = {
  low: 'idle', medium: 'warning', high: 'error', critical: 'error',
};

const IMPACT_ACCENT = {
  low: 'var(--v2-text-muted)',
  medium: 'var(--v2-accent-amber)',
  high: 'var(--v2-accent-red)',
  critical: 'var(--v2-accent-red)',
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
    <div className="v2-event-calendar">
      <div className="v2-ec-header">
        <span className="v2-ec-title">
          Events
          {blackout?.in_blackout && (
            <span className="v2-ec-blackout-badge">BLACKOUT</span>
          )}
        </span>
        <button className="v2-ec-add" onClick={() => setShowForm(!showForm)}>
          {showForm ? '\u00d7' : '+'}
        </button>
      </div>

      {showForm && (
        <div className="v2-ec-form">
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
          <button className="v2-ec-submit" onClick={createEvent}>Add</button>
        </div>
      )}

      {events.length === 0 ? (
        <div className="v2-ec-empty">No upcoming events</div>
      ) : (
        <div className="v2-ec-list">
          {events.slice(0, 8).map((e, i) => {
            const eventDate = new Date(e.event_date);
            const isBlackout = e.blackout_start && e.blackout_end &&
              now >= new Date(e.blackout_start) && now <= new Date(e.blackout_end);
            const isPast = eventDate < now;

            return (
              <div key={i} className={`v2-ec-row ${isBlackout ? 'v2-ec-row--blackout' : ''} ${isPast ? 'v2-ec-row--past' : ''}`}>
                <div className="v2-ec-date">
                  <span className="v2-ec-day">{eventDate.getDate()}</span>
                  <span className="v2-ec-month">{eventDate.toLocaleString('default', { month: 'short' })}</span>
                </div>
                <div className="v2-ec-info">
                  <span className="v2-ec-name">{e.event_name}</span>
                  <span className="v2-ec-meta">
                    <StatusPulse status={IMPACT_COLORS[e.impact_estimate] || 'idle'} size={5} />
                    <span className="v2-ec-impact" style={{ color: IMPACT_ACCENT[e.impact_estimate] }}>{e.impact_estimate}</span>
                    <span className="v2-ec-type">{e.event_type}</span>
                    <span className="v2-ec-time">{eventDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </span>
                </div>
                <button className="v2-ec-delete" onClick={() => deleteEvent(e.id)}>{'\u00d7'}</button>
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        .v2-event-calendar { }
        .v2-ec-header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: var(--v2-space-md);
        }
        .v2-ec-title {
          font-family: var(--v2-font-data); font-size: 11px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 1.5px; color: var(--v2-text-muted);
          display: flex; align-items: center; gap: var(--v2-space-sm);
        }
        .v2-ec-blackout-badge {
          font-size: 9px; font-weight: 700; padding: 2px 6px;
          background: rgba(239,83,80,0.15); color: var(--v2-accent-red);
          border: 1px solid rgba(239,83,80,0.3); border-radius: var(--v2-radius-sm);
        }
        .v2-ec-add {
          font-size: 18px; color: var(--v2-text-muted);
          width: 24px; height: 24px;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; transition: color var(--v2-duration-fast);
          background: none; border: none;
        }
        .v2-ec-add:hover { color: var(--v2-accent-cyan); }
        .v2-ec-form {
          display: flex; gap: var(--v2-space-xs); flex-wrap: wrap; align-items: center;
          padding: var(--v2-space-sm) 0; border-bottom: 1px solid var(--v2-border);
          margin-bottom: var(--v2-space-sm);
        }
        .v2-ec-form input, .v2-ec-form select {
          font-family: var(--v2-font-data); font-size: 11px;
          padding: 4px 6px; max-width: 140px;
          background: var(--v2-bg-tertiary); border: 1px solid var(--v2-border);
          color: var(--v2-text-primary); border-radius: var(--v2-radius-sm);
        }
        .v2-ec-submit {
          font-family: var(--v2-font-data); font-size: 10px; font-weight: 600;
          color: var(--v2-accent-cyan); cursor: pointer; padding: 4px 8px;
          border: 1px solid var(--v2-accent-cyan); border-radius: var(--v2-radius-sm);
          background: rgba(79,195,247,0.05);
          transition: background var(--v2-duration-fast);
        }
        .v2-ec-submit:hover { background: rgba(79,195,247,0.1); }
        .v2-ec-list { display: flex; flex-direction: column; }
        .v2-ec-row {
          display: flex; align-items: center; gap: var(--v2-space-sm);
          padding: var(--v2-space-xs) 0; border-bottom: 1px solid var(--v2-border);
        }
        .v2-ec-row--blackout {
          background: rgba(239,83,80,0.04);
          border-left: 2px solid var(--v2-accent-red);
          padding-left: var(--v2-space-sm);
        }
        .v2-ec-row--past { opacity: 0.4; }
        .v2-ec-date {
          display: flex; flex-direction: column; align-items: center; min-width: 36px;
        }
        .v2-ec-day {
          font-family: var(--v2-font-data); font-size: 16px; font-weight: 500;
          line-height: 1; color: var(--v2-text-primary);
        }
        .v2-ec-month {
          font-family: var(--v2-font-data); font-size: 9px;
          color: var(--v2-text-muted); text-transform: uppercase;
        }
        .v2-ec-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
        .v2-ec-name { font-size: 12px; color: var(--v2-text-primary); }
        .v2-ec-meta { display: flex; align-items: center; gap: var(--v2-space-xs); }
        .v2-ec-impact {
          font-family: var(--v2-font-data); font-size: 9px; font-weight: 600;
          text-transform: uppercase;
        }
        .v2-ec-type {
          font-size: 9px; color: var(--v2-text-muted); text-transform: uppercase;
        }
        .v2-ec-time {
          font-family: var(--v2-font-data); font-size: 10px; color: var(--v2-text-secondary);
        }
        .v2-ec-empty {
          color: var(--v2-text-muted); font-size: 13px; padding: var(--v2-space-md);
          text-align: center;
        }
        .v2-ec-delete {
          font-size: 14px; color: var(--v2-text-muted); cursor: pointer;
          transition: color var(--v2-duration-fast); opacity: 0;
          background: none; border: none;
        }
        .v2-ec-row:hover .v2-ec-delete { opacity: 1; }
        .v2-ec-delete:hover { color: var(--v2-accent-red); }
      `}</style>
    </div>
  );
}
