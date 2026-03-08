import { create } from 'zustand';
import { api } from '../lib/api';

// Agent pipeline definition — matches backend AGENT_REGISTRY
const AGENT_PIPELINE = [
  { name: 'trend', layer: 'knowledge' },
  { name: 'momentum', layer: 'knowledge' },
  { name: 'volatility', layer: 'knowledge' },
  { name: 'volume', layer: 'knowledge' },
  { name: 'pattern', layer: 'knowledge' },
  { name: 'orderflow', layer: 'knowledge' },
  { name: 'macro', layer: 'knowledge' },
  { name: 'sentiment', layer: 'knowledge' },
  { name: 'position_reviewer', layer: 'review' },
  { name: 'regime_classifier', layer: 'strategy' },
  { name: 'synthesizer', layer: 'strategy' },
  { name: 'risk_manager', layer: 'strategy' },
  { name: 'performance_analyst', layer: 'analysis' },
  { name: 'pattern_discovery', layer: 'analysis' },
];

const LAYERS = ['knowledge', 'review', 'strategy', 'analysis'];

function buildAgentList() {
  return AGENT_PIPELINE.map(a => ({
    name: a.name,
    layer: a.layer,
    status: 'pending', // pending | running | done | error
    duration_ms: null,
    cost_usd: null,
    signals_count: null,
    error: null,
  }));
}

let elapsedInterval = null;
let autoDismissTimer = null;

export const useCycleStore = create((set, get) => ({
  // State machine: idle | confirming | starting | running | success | error
  phase: 'idle',
  // Panel mode: collapsed | expanded
  panelMode: 'collapsed',

  // Cycle data
  cycleNumber: null,
  agents: [],
  startedAt: null,
  elapsed: 0,
  totalCost: 0,
  totalSignals: 0,
  errorMessage: null,
  cycleResult: null,

  // Last completed cycle info (for idle pill)
  lastCycleNumber: null,
  lastCycleTime: null,

  // Actions
  requestCycle: () => set({ phase: 'confirming' }),
  cancelConfirm: () => set({ phase: 'idle' }),

  confirmCycle: async () => {
    set({ phase: 'starting', errorMessage: null });
    try {
      await api('/agents/cycle', { method: 'POST', body: '{}' });
      // cycle_start WS event will transition to 'running'
    } catch (err) {
      const msg = err?.message || 'Failed to start cycle';
      // 409 = already running
      set({ phase: 'error', errorMessage: msg });
    }
  },

  dismissError: () => set({ phase: 'idle', errorMessage: null }),
  dismissSuccess: () => {
    clearTimeout(autoDismissTimer);
    set({ phase: 'idle', panelMode: 'collapsed' });
  },

  togglePanel: () => set(s => ({
    panelMode: s.panelMode === 'collapsed' ? 'expanded' : 'collapsed',
  })),

  expand: () => set({ panelMode: 'expanded' }),
  collapse: () => set({ panelMode: 'collapsed' }),

  // WebSocket event handlers
  onCycleStart: (data) => {
    clearInterval(elapsedInterval);
    clearTimeout(autoDismissTimer);

    const now = Date.now();
    set({
      phase: 'running',
      panelMode: 'expanded',
      cycleNumber: data.cycleNumber,
      agents: buildAgentList(),
      startedAt: now,
      elapsed: 0,
      totalCost: 0,
      totalSignals: 0,
      errorMessage: null,
      cycleResult: null,
    });

    elapsedInterval = setInterval(() => {
      const s = get();
      if (s.phase === 'running' && s.startedAt) {
        set({ elapsed: Math.floor((Date.now() - s.startedAt) / 1000) });
      }
    }, 1000);
  },

  onAgentComplete: (data) => {
    set(s => {
      if (s.phase !== 'running') return {};
      const agents = s.agents.map(a => {
        if (a.name === data.agent_name) {
          return {
            ...a,
            status: data.error ? 'error' : 'done',
            duration_ms: data.duration_ms || null,
            cost_usd: data.cost_usd || null,
            signals_count: data.signals_count ?? data.proposals ?? data.reviews_count ?? null,
            error: data.error || null,
          };
        }
        return a;
      });

      // Mark next pending agent in same/next layer as running
      const doneNames = new Set(agents.filter(a => a.status === 'done' || a.status === 'error').map(a => a.name));
      for (const agent of agents) {
        if (agent.status === 'pending' && !doneNames.has(agent.name)) {
          // Only auto-mark knowledge agents as running (they run in parallel batches)
          if (agent.layer === 'knowledge' || agent.layer === data.layer) {
            agent.status = 'running';
            break;
          }
        }
      }

      const newCost = agents.reduce((sum, a) => sum + (a.cost_usd || 0), 0);
      const newSignals = agents.reduce((sum, a) => sum + (a.signals_count || 0), 0);

      return { agents, totalCost: newCost, totalSignals: newSignals };
    });
  },

  onCycleComplete: (data) => {
    clearInterval(elapsedInterval);
    const s = get();

    set({
      phase: 'success',
      cycleResult: data,
      lastCycleNumber: data.cycleNumber || s.cycleNumber,
      lastCycleTime: Date.now(),
    });

    // Mark any still-pending agents as done
    set(s2 => ({
      agents: s2.agents.map(a =>
        a.status === 'pending' || a.status === 'running'
          ? { ...a, status: 'done' }
          : a
      ),
    }));

    // Auto-dismiss after 8s
    autoDismissTimer = setTimeout(() => {
      const current = get();
      if (current.phase === 'success') {
        set({ phase: 'idle', panelMode: 'collapsed' });
      }
    }, 8000);
  },

  onCycleAborted: (data) => {
    clearInterval(elapsedInterval);
    set({
      phase: 'error',
      errorMessage: data.reason || 'Cycle aborted',
      lastCycleNumber: data.cycleNumber,
      lastCycleTime: Date.now(),
    });
  },

  onCycleError: (data) => {
    clearInterval(elapsedInterval);
    set({
      phase: 'error',
      errorMessage: data.error || data.message || 'Cycle failed',
    });
  },

  onCycleReport: (data) => {
    // Store for potential display — forwarded to cycleReport store in useWebSocket
  },

  onTradesExecuted: () => {
    // Visual feedback — handled by data store already
  },

  // Computed helpers
  getLayerStats: () => {
    const agents = get().agents;
    const stats = {};
    for (const layer of LAYERS) {
      const layerAgents = agents.filter(a => a.layer === layer);
      stats[layer] = {
        total: layerAgents.length,
        done: layerAgents.filter(a => a.status === 'done').length,
        error: layerAgents.filter(a => a.status === 'error').length,
      };
    }
    return stats;
  },

  getProgress: () => {
    const agents = get().agents;
    if (agents.length === 0) return 0;
    const done = agents.filter(a => a.status === 'done' || a.status === 'error').length;
    return Math.round((done / agents.length) * 100);
  },
}));
