const API_BASE = '/api';

// Access token in memory only — never localStorage.
// Refresh token lives in an HttpOnly cookie set by the server (not accessible to JS).
let accessToken = null;

export function setTokens(access) {
  accessToken = access;
}

export function clearTokens() {
  accessToken = null;
}

export function getToken() { return accessToken; }

async function refreshAccessToken() {
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // Send HttpOnly refreshToken cookie
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    clearTokens();
    throw new Error('Refresh failed');
  }
  const data = await res.json();
  setTokens(data.accessToken);
  return data.accessToken;
}

export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let res = await fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.timeout(30000),
    credentials: 'include',
    ...opts,
    headers,
  });

  // Auto-refresh on 401
  if (res.status === 401) {
    try {
      const newToken = await refreshAccessToken();
      headers.Authorization = `Bearer ${newToken}`;
      res = await fetch(`${API_BASE}${path}`, { ...opts, credentials: 'include', headers });
    } catch {
      clearTokens();
      window.location.reload();
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    let errMsg = res.statusText || 'Request failed';
    try {
      const ct = res.headers.get('content-type');
      if (ct?.includes('application/json')) {
        const err = await res.json();
        errMsg = err.error || errMsg;
      }
    } catch { /* ignore parse error */ }
    throw new Error(errMsg);
  }

  return res.json();
}

export async function login(email, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    credentials: 'include', // Receive HttpOnly refreshToken cookie
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Login failed');
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

// Attempt silent refresh using HttpOnly cookie on page reload
export async function silentRefresh() {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({}),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.accessToken) {
      setTokens(data.accessToken);
      return true;
    }
  } catch {}
  return false;
}
