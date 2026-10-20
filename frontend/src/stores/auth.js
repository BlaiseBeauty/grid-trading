import { create } from 'zustand';
import { login as apiLogin, logout as apiLogout, silentRefresh, onAuthLost } from '../lib/api';

export const useAuthStore = create((set, get) => ({
  isAuthenticated: false,
  // true until the boot-time silent refresh has settled; App renders a splash meanwhile
  initialising: true,
  user: null,
  error: null,
  loading: false,

  // Called once on app boot: restores the session from the HttpOnly refresh cookie.
  init: async () => {
    if (!get().initialising) return;
    const ok = await silentRefresh();
    set({ isAuthenticated: ok, initialising: false });
  },

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const data = await apiLogin(email, password);
      set({ isAuthenticated: true, user: data.user || { email }, loading: false });
    } catch (err) {
      set({ error: err.message, loading: false });
    }
  },

  logout: async () => {
    await apiLogout();
    set({ isAuthenticated: false, user: null });
  },

  // Called by api.js when the session can no longer be refreshed.
  sessionLost: () => {
    set({ isAuthenticated: false, user: null, error: 'Session expired. Please sign in again.' });
  },
}));

onAuthLost(() => useAuthStore.getState().sessionLost());
