const API_BASE = '/api';
const REQUEST_TIMEOUT_MS = 30000;

// Access token in memory only — never localStorage.
// Refresh token lives in an HttpOnly cookie set by the server (not accessible to JS).
let accessToken = null;

// Auth-loss listeners: the auth store registers here so api.js never imports the store
// (avoids a circular import) and never reloads the page.
const authLostListeners = new Set();
export function onAuthLost(fn) {
  authLostListeners.add(fn);
  return () => authLostListeners.delete(fn);
}
function notifyAuthLost() {
  for (const fn of authLostListeners) {
    try { fn(); } catch (err) { console.error('[AUTH] listener failed:', err); }
  }
}

export function setTokens(access) {
  accessToken = access;
}

export function clearTokens() {
  accessToken = null;
}

export function getToken() { return accessToken; }

// Auth endpoints must never trigger a refresh-and-retry loop.
function isAuthPath(path) {
  return path.startsWith('/auth/');
}

function httpError(status, fallback, body) {
  if (status === 429) {
    return new Error('Too many attempts. Please wait a minute and try again.');
  }
  return new Error((body && body.error) || fallback || 'Request failed');
}

// One shared in-flight refresh promise: concurrent 401s wait on the same request.
let refreshInFlight = null;

// Resolves with the new access token, or null when the session cannot be refreshed.
// Never throws; never retries (the server rate limits /auth/refresh).
function refreshSession() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Send HttpOnly refreshToken cookie
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.accessToken) return null;
      setTokens(data.accessToken);
      return data.accessToken;
    } catch (err) {
      console.error('[AUTH] Refresh failed:', err?.message || err);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function buildRequest(path, opts, token) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    credentials: 'include',
    ...opts,
    headers,
  });
}

export async function api(path, opts = {}) {
  let res = await buildRequest(path, opts, accessToken);

  // Auto-refresh once on 401 (never for auth endpoints)
  if (res.status === 401 && !isAuthPath(path)) {
    const newToken = await refreshSession();
    if (!newToken) {
      clearTokens();
      notifyAuthLost();
      throw new Error('Session expired. Please sign in again.');
    }
    // Retry once; buildRequest gives the retry its own fresh timeout signal
    res = await buildRequest(path, opts, newToken);
    if (res.status === 401) {
      clearTokens();
      notifyAuthLost();
      throw new Error('Session expired. Please sign in again.');
    }
  }

  if (!res.ok) {
    let body = null;
    try {
      const ct = res.headers.get('content-type');
      if (ct?.includes('application/json')) body = await res.json();
    } catch (err) {
      console.warn('[API] Could not parse error body:', err?.message || err);
    }
    throw httpError(res.status, res.statusText, body);
  }

  return res.json();
}

export async function login(email, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    credentials: 'include', // Receive HttpOnly refreshToken cookie
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(res.status, 'Login failed', err);
  }
  const data = await res.json();
  setTokens(data.accessToken); // Only store access token in memory
  return data;
}

export async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch (err) {
    // Server invalidation failed — still clear local state
    console.error('[AUTH] Logout API failed (server may not have invalidated token):', err.message);
  }
  clearTokens();
}

// Attempt silent refresh using the HttpOnly cookie on page load.
// De-duplicated: StrictMode double-mounts and concurrent callers share one request.
let silentInFlight = null;
export function silentRefresh() {
  if (silentInFlight) return silentInFlight;
  silentInFlight = refreshSession()
    .then((token) => !!token)
    .finally(() => { silentInFlight = null; });
  return silentInFlight;
}
