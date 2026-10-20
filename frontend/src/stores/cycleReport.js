import { create } from 'zustand';
import { api } from '../lib/api';

export const useCycleReportStore = create((set) => ({
  latestReport: null,
  history: [],
  // loaded = the history request completed once (so "no report" is confirmed-empty); error = last attempt failed
  loaded: false,
  error: null,

  setLatestReport: (report) => set({ latestReport: report }),
  setHistory: (reports) => set({ history: reports }),

  fetchHistory: async () => {
    set({ error: null });
    try {
      const reports = await api('/cycle-reports');
      set({
        history: reports,
        latestReport: reports.length > 0 ? reports[0].report : null,
        loaded: true,
      });
    } catch (err) {
      console.error('Cycle reports fetch:', err);
      set({ error: err?.message || 'Failed to load cycle reports' });
    }
  },
}));
