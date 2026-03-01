import { useEffect, useRef } from 'react';
import { useDataStore } from '../stores/data';

export function useWebSocket() {
  const wsRef = useRef(null);
  const storeRef = useRef(useDataStore.getState());

  // Keep storeRef in sync without re-triggering the effect
  useEffect(() => {
    return useDataStore.subscribe(s => { storeRef.current = s; });
  }, []);

  useEffect(() => {
    let reconnectTimer;

    function connect() {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        storeRef.current.addFeedItem({ type: 'system', message: 'Connected to GRID' });
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const s = storeRef.current;
          s.addFeedItem({ type: msg.type, ...msg.data });

          switch (msg.type) {
            case 'cycle_start':
              s.setCycleStatus({ running: true, cycleNumber: msg.data.cycleNumber, agents: msg.data.agents, completed: [] });
              break;
            case 'agent_complete':
              s.addCompletedAgent(msg.data);
              break;
            case 'cycle_complete':
              s.setLastCycle(msg.data);
              s.setCycleStatus(null);
              s.fetchPortfolio();
              s.fetchTrades();
              s.fetchSignals();
              s.fetchAgents();
              s.fetchSystem();
              break;
            case 'trades_executed':
              s.fetchTrades();
              s.fetchPortfolio();
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
                s.updatePrice(msg.data.symbol, msg.data.price, msg.data.change24h);
              }
              break;
            case 'standing_order_triggered':
              s.fetchTrades();
              s.fetchPortfolio();
              s.fetchStandingOrders();
              break;
          }
        } catch {}
      };

      ws.onclose = () => {
        storeRef.current.addFeedItem({ type: 'system', message: 'Disconnected — reconnecting...' });
        reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);
}
