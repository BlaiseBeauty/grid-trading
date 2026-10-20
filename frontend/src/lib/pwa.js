import { useSyncExternalStore } from 'react';

// Service-worker registration with a message-based update flow:
//   new worker installs -> `updateAvailable` -> UpdateToast -> user clicks Reload
//   -> we post SKIP_WAITING -> new worker activates -> controllerchange -> page reloads.
// Nothing ever swaps under the user mid-session without that click.
let waitingWorker = null;
let updateAvailable = false;
let userAccepted = false;
const listeners = new Set();

function setAvailable(worker) {
  waitingWorker = worker;
  updateAvailable = true;
  for (const fn of listeners) fn();
}

export function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  // The dev server has no built sw.js worth caching; only register for production builds
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // A worker may already be waiting from a previous visit
      if (reg.waiting && navigator.serviceWorker.controller) setAvailable(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            setAvailable(installing);
          }
        });
      });

      // Look for new deploys while the app stays open (hourly)
      setInterval(() => {
        reg.update().catch((err) => console.warn('[PWA] update check failed:', err?.message || err));
      }, 60 * 60 * 1000);
    }).catch((err) => {
      console.error('[PWA] Service worker registration failed:', err);
    });
  });

  // Only reload once the user asked for the update
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userAccepted) window.location.reload();
  });
}

export function applyUpdate() {
  if (!waitingWorker) return;
  userAccepted = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

export function dismissUpdate() {
  updateAvailable = false;
  for (const fn of listeners) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useUpdateAvailable() {
  return useSyncExternalStore(subscribe, () => updateAvailable, () => false);
}
