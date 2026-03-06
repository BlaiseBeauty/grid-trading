import { create } from 'zustand';
import { api } from '../lib/api';

export const useCycleReportStore = create((set) => ({
  latestReport: null,
  history: [],

  setLatestReport: (report) => set({ latestReport: report }),
  setHistory: (reports) => set({ history: reports }),

  fetchHistory: async () => {
    try {
      const reports = await api('/cycle-reports');
      set({
        history: reports,
        latestReport: reports.length > 0 ? reports[0].report : null,
      });
    } catch (err) {
      console.error('Cycle reports fetch:', err);
    }
  },
}));
