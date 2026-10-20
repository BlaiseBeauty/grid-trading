import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

// Fetch one endpoint with explicit loading / error / loaded state so a page can tell
// "failed to load" (show error + Retry) apart from "loaded and empty" (show empty state).
//
//   const { data, loaded, loading, error, reload } = useApiResource('/analytics/summary', { initial: null });
//
// `path` may be null to skip fetching (e.g. while a selection is missing). A change of `path` refetches.
export default function useApiResource(path, { initial = null } = {}) {
  const [state, setState] = useState({ data: initial, loading: path != null, error: null, loaded: false });
  const aliveRef = useRef(true);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (path == null) return;
    const seq = ++seqRef.current;
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const data = await api(path);
      if (!aliveRef.current || seq !== seqRef.current) return;
      setState({ data, loading: false, error: null, loaded: true });
    } catch (err) {
      console.error(`[useApiResource] ${path} failed:`, err);
      if (!aliveRef.current || seq !== seqRef.current) return;
      setState(s => ({ ...s, loading: false, error: err?.message || 'Request failed' }));
    }
  }, [path]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => { aliveRef.current = false; };
  }, [load]);

  return { ...state, reload: load };
}
