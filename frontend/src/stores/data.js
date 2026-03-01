import { create } from 'zustand';
import { api } from '../lib/api';

export const useDataStore = create((set, get) => ({
  // Portfolio
  portfolio: [],
  portfolioValue: 0,
  tradeStats: null,

  // Agents
  agents: null,
  decisions: [],
  regime: [],
  rejected: [],

  // Signals
  signals: [],

  // Trades
  trades: [],
  openTrades: [],

  // Templates & Learnings
  templates: [],
  antiPatterns: [],
  learnings: [],
  learningsSummary: [],

  // Standing Orders
  standingOrders: [],

  // System
  system: null,
  costs: null,

  // WebSocket feed
  feed: [],
  lastCycle: null,
  cycleStatus: null, // { running, cycleNumber, agents, completed[] }

  // Loading states
  loading: {},

  setLoading: (key, val) => set(s => ({ loading: { ...s.loading, [key]: val } })),

  addFeedItem: (item) => set(s => ({
    feed: [{ ...item, ts: Date.now() }, ...s.feed].slice(0, 100),
  })),

  setLastCycle: (data) => set({ lastCycle: data }),

  setCycleStatus: (status) => set({ cycleStatus: status }),

  addCompletedAgent: (data) => set(s => {
    if (!s.cycleStatus) return {};
    return { cycleStatus: { ...s.cycleStatus, completed: [...s.cycleStatus.completed, data] } };
  }),

  // Fetchers
  fetchPortfolio: async () => {
    get().setLoading('portfolio', true);
    try {
      const [portfolioData, stats] = await Promise.all([
        api('/portfolio'),
        api('/trades/stats'),
      ]);
      const { holdings = [], total_value, realised_pnl, unrealised_pnl, starting_capital, ...rest } = portfolioData;
      set({
        portfolio: holdings,
        portfolioValue: total_value || starting_capital || 10000,
        tradeStats: stats,
      });
    } catch (err) { console.error('Portfolio fetch:', err); }
    get().setLoading('portfolio', false);
  },

  fetchAgents: async () => {
    get().setLoading('agents', true);
    try {
      const [agents, decisions, regime, rejected] = await Promise.all([
        api('/agents'),
        api('/agents/decisions?limit=30'),
        api('/agents/regime'),
        api('/agents/rejected?limit=20'),
      ]);
      set({ agents, decisions, regime, rejected });
    } catch (err) { console.error('Agents fetch:', err); }
    get().setLoading('agents', false);
  },

  fetchSignals: async () => {
    try {
      const signals = await api('/signals/active');
      set({ signals });
    } catch (err) { console.error('Signals fetch:', err); }
  },

  fetchTrades: async () => {
    get().setLoading('trades', true);
    try {
      const [trades, openTrades] = await Promise.all([
        api('/trades?limit=50'),
        api('/trades?status=open'),
      ]);
      set({ trades, openTrades });
    } catch (err) { console.error('Trades fetch:', err); }
    get().setLoading('trades', false);
  },

  fetchStandingOrders: async () => {
    try {
      const standingOrders = await api('/standing-orders');
      set({ standingOrders });
    } catch (err) { console.error('Standing orders fetch:', err); }
  },

  fetchTemplates: async () => {
    get().setLoading('templates', true);
    try {
      const [templates, antiPatterns] = await Promise.all([
        api('/templates'),
        api('/anti-patterns'),
      ]);
      set({ templates, antiPatterns });
    } catch (err) { console.error('Templates fetch:', err); }
    get().setLoading('templates', false);
  },

  fetchLearnings: async () => {
    try {
      const [learnings, learningsSummary] = await Promise.all([
        api('/learnings?limit=50'),
        api('/learnings/summary'),
      ]);
      set({ learnings, learningsSummary });
    } catch (err) { console.error('Learnings fetch:', err); }
  },

  fetchSystem: async () => {
    try {
      const [system, costs, lastCycle] = await Promise.all([
        api('/system/health'),
        api('/costs/summary'),
        api('/system/last-cycle'),
      ]);
      set({ system, costs, lastCycle });
    } catch (err) { console.error('System fetch:', err); }
  },

  // Actions
  triggerCycle: () => api('/agents/cycle', { method: 'POST', body: '{}' }),
  triggerAnalysis: () => api('/agents/analyse', { method: 'POST', body: '{}' }),
  refreshData: () => api('/agents/refresh-data', { method: 'POST', body: '{}' }),
}));
