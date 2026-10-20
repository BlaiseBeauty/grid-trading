import { useSyncExternalStore } from 'react';

// Theme preference: 'light' (default) | 'dark'.
// localStorage is used for this UI preference ONLY (no auth/data), always wrapped in try/catch.
const STORAGE_KEY = 'grid-theme';
const THEME_COLORS = { light: '#f4f5f8', dark: '#1b1d23' }; // matches --v2-bg-primary per theme
const listeners = new Set();

export function readStoredTheme() {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'dark' ? 'dark' : 'light';
  } catch (err) {
    console.warn('[theme] localStorage unavailable, using light:', err?.message || err);
    return 'light';
  }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.light);
}

export function getTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch (err) {
    console.warn('[theme] could not persist preference:', err?.message || err);
  }
  applyTheme(next);
  for (const fn of listeners) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Components (charts) re-render / re-apply colours when this changes.
export function useTheme() {
  return useSyncExternalStore(subscribe, getTheme, () => 'light');
}

// Called once before first render (main.jsx).
export function initTheme() {
  applyTheme(readStoredTheme());
}
