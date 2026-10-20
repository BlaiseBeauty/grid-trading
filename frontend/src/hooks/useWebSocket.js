import { useEffect, useRef } from 'react';
import { useDataStore } from '../stores/data';
import { useCycleReportStore } from '../stores/cycleReport';
import { useCycleStore } from '../stores/cycle';
import usePlatformStore from '../stores/platform';
import { useAuthStore } from '../stores/auth';
import { getToken, silentRefresh } from '../lib/api';

export function useWebSocket() {
  const wsRef = useRef(null);
  const storeRef = useRef(useDataStore.getState());

  // Keep storeRef in sync without re-triggering the effect
  useEffect(() => {
    return useDataStore.subscribe(s => { storeRef.current = s; });
  }, []);

  useEffect(() => {
    // `disposed` flips on cleanup (logout / unmount) and stops every future reconnect.
    let disposed = false;
    let reconnectTimer = null;
    let attempt = 0;          // consecutive failed connects, drives backoff
    let authRejections = 0;   // consecutive 4401 closes without a good session in between
    let priceTimer = null;
    const pendingPrices = {}; // price_update ticks buffered, flushed at most ~1/s

    function flushPrices() {
      priceTimer = null;
      const batch = { ...pendingPrices };
      for (const k of Object.keys(pendingPrices)) delete pendingPrices[k];
      if (Object.keys(batch).length > 0) storeRef.current.applyPrices(batch, 'live');
    }

    function scheduleReconnect() {
      if (disposed) return;
      // Exponential backoff 2s, 4s, 8s ... capped at 30s, with +/-25% jitter
      const base = Math.min(2000 * 2 ** attempt, 30000);
      const delay = Math.round(base * (0.75 + Math.random() * 0.5));
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
      reconnectTimer = null;
      if (disposed) return;
      // Fresh token on every (re)connect. No token means we are logged out: stop, do not poll.
      const token = getToken();
      if (!token) return;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        // Authenticate via first message — token never sent in URL
        ws.send(JSON.stringify({ type: 'auth', token }));
        attempt = 0;
        storeRef.current.addFeedItem({ type: 'system', message: 'Connected to GRID' });
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        authRejections = 0;
        try {
          const msg = JSON.parse(event.data);
          const s = storeRef.current;
          if (msg.type !== 'price_update') {
            s.addFeedItem({ type: msg.type, ...msg.data });
          }

          const cs = useCycleStore.getState();

          switch (msg.type) {
            case 'cycle_start':
              s.setCycleStatus({ running: true, cycleNumber: msg.data.cycleNumber, agents: msg.data.agents, completed: [] });
              cs.onCycleStart(msg.data);
              break;
            case 'agent_complete':
              s.addCompletedAgent(msg.data);
              cs.onAgentComplete(msg.data);
              break;
            case 'cycle_complete':
              s.setLastCycle(msg.data);
              s.setCycleStatus(null);
              s.fetchPortfolio();
              s.fetchTrades();
              s.fetchSignals();
              s.fetchAgents();
              s.fetchSystem();
              s.fetchEquity();
              cs.onCycleComplete(msg.data);
              break;
            case 'cycle_aborted':
            case 'cycle_skipped':
              s.setCycleStatus(null);
              cs.onCycleAborted(msg.data);
              break;
            case 'cycle_error':
              s.setCycleStatus(null);
              cs.onCycleError(msg.data);
              break;
            case 'trades_executed':
              s.fetchTrades();
              s.fetchPortfolio();
              s.setTradeFlash(true);
              cs.onTradesExecuted();
              break;
            case 'positions_closed':
              s.fetchTrades();
              s.fetchPortfolio();
              break;
            case 'analysis_complete':
              s.fetchTemplates();
              s.fetchLearnings();
              break;
            case 'price_update':
              if (msg.data?.symbol) {
                // Buffer and flush at most once per second (store writes re-render consumers)
                pendingPrices[msg.data.symbol] = { price: msg.data.price, change24h: msg.data.change24h };
                if (!priceTimer) priceTimer = setTimeout(flushPrices, 1000);
              }
              break;
            case 'calibration_update':
              s.setCalibrationUpdate(msg.data);
              break;
            case 'position_review':
              s.fetchTrades();
              s.fetchPortfolio();
              break;
            case 'standing_order_triggered':
              s.fetchTrades();
              s.fetchPortfolio();
              s.fetchStandingOrders();
              s.setTradeFlash(true);
              break;
            case 'trade':
              s.fetchTrades();
              s.fetchPortfolio();
              s.setTradeFlash(true);
              break;
            case 'trade_closed':
              s.fetchTrades();
              s.fetchPortfolio();
              break;
            case 'scram_activated':
              s.fetchSystem();
              break;
            case 'scram_cleared':
              s.fetchSystem();
              break;
            case 'cycle_report':
              useCycleReportStore.getState().setLatestReport(msg.data);
              cs.onCycleReport(msg.data);
              break;
            case 'backtest_progress':
              s.setBacktestProgress(msg.data);
              break;
            case 'backtest_complete':
              s.setBacktestProgress(null);
              break;
            case 'backtest_failed':
              s.setBacktestProgress({ ...msg.data, failed: true });
              break;
            case 'bus_event': {
              const busEvent = msg.data;
              // Ring buffer — keep last 50 events
              const notifyTypes = [
                'trade_closed', 'scram_triggered', 'thesis_created',
                'thesis_conviction_updated', 'performance_digest',
              ];
              const shouldNotify = notifyTypes.includes(busEvent.event_type);
              useDataStore.setState(state => ({
                busEvents: [busEvent, ...state.busEvents].slice(0, 50),
                unreadBusCount: shouldNotify
                  ? state.unreadBusCount + 1
                  : state.unreadBusCount,
              }));

              // Also dispatch to platform store for shell components
              const ps = usePlatformStore.getState();
              ps.addBusEvent(busEvent);
              if (ps.shouldNotify(busEvent.event_type)) {
                ps.incrementUnread();
              }
              // Refresh God View on relevant events (refetch; never blank the strips, which would
              // read as "confirmed empty" until the next 5-minute poll)
              if (busEvent.event_type === 'thesis_created' ||
                  busEvent.event_type === 'thesis_conviction_updated' ||
                  busEvent.event_type === 'allocation_guidance') {
                ps.refreshGodView();
              }
              break;
            }
          }
        } catch (err) {
          console.error('[WS] Message handling error:', err);
        }
      };

      ws.onclose = async (event) => {
        if (disposed) return;

        // 4401 = the server rejected our auth (invalid, or the access token expired).
        // Never reconnect blindly: refresh once via the shared 401 flow, then reconnect with the new token.
        if (event.code === 4401) {
          authRejections += 1;
          storeRef.current.addFeedItem({ type: 'system', message: 'Session rejected by server' });
          if (authRejections > 2) {
            // Server keeps rejecting fresh tokens: stop, do not hammer /auth/refresh (rate limited)
            console.error('[WS] Repeated auth rejection; giving up until the next login');
            return;
          }
          const ok = await silentRefresh();
          if (disposed) return;
          if (!ok) {
            useAuthStore.getState().sessionLost();
            return;
          }
          connect();
          return;
        }

        storeRef.current.addFeedItem({ type: 'system', message: 'Disconnected — reconnecting...' });
        scheduleReconnect();
      };

      ws.onerror = () => {
        // The browser follows onerror with onclose, which owns the reconnect; nothing to do here.
        console.warn('[WS] socket error');
      };
    }

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(priceTimer);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);
}
