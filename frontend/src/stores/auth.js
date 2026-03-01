import { create } from 'zustand';
import { login as apiLogin, logout as apiLogout, getToken } from '../lib/api';

export const useAuthStore = create((set) => ({
  isAuthenticated: !!getToken(),
  user: null,
  error: null,
  loading: false,

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

  checkAuth: () => {
    set({ isAuthenticated: !!getToken() });
  },
}));
