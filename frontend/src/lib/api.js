const API_BASE = '/api';

// H-16: Access token stored in memory only (not localStorage)
// Refresh token is in an HttpOnly cookie set by the server
let accessToken = localStorage.getItem('grid_token'); // Migration: read existing token
let refreshToken = localStorage.getItem('grid_refresh'); // Migration: read existing token

export function setTokens(access, refresh) {
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem('grid_token', access);
  localStorage.setItem('grid_refresh', refresh);
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem('grid_token');
  localStorage.removeItem('grid_refresh');
}

export function getToken() { return accessToken; }

async function refreshAccessToken() {
  if (!refreshToken) throw new Error('No refresh token');
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) { clearTokens(); throw new Error('Refresh failed'); }
  const data = await res.json();
  setTokens(data.accessToken, data.refreshToken);
  return data.accessToken;
}

export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let res = await fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.timeout(30000),
    ...opts,
    headers,
  });

  // Auto-refresh on 401
  if (res.status === 401 && refreshToken) {
    try {
      const newToken = await refreshAccessToken();
      headers.Authorization = `Bearer ${newToken}`;
      res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Login failed');
  }
  const data = await res.json();
  setTokens(data.accessToken, data.refreshToken);
  return data;
}

export async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  clearTokens();
}

// H-16: Attempt silent refresh using HttpOnly cookie on page reload
export async function silentRefresh() {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // Send HttpOnly cookies
      body: JSON.stringify({}),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.accessToken) {
      accessToken = data.accessToken;
      // Don't store in localStorage — keep in memory only
      return true;
    }
  } catch {}
  return false;
}
