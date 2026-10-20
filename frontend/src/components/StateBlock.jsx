// Shared load-state blocks. Rule: a failed load shows ErrorState (with Retry), never EmptyState.
// Empty means the server confirmed there is nothing.

export function ErrorState({ error, onRetry, title = 'Could not load this data' }) {
  return (
    <div className="state-block state-block--error" role="alert">
      <div className="state-block__title">{title}</div>
      {error && <div className="state-block__detail">{typeof error === 'string' ? error : error.message}</div>}
      {onRetry && (
        <button type="button" className="state-block__btn" onClick={onRetry}>Retry</button>
      )}
    </div>
  );
}

export function EmptyState({ children }) {
  return <div className="state-block">{children}</div>;
}

export function LoadingState({ children = 'Loading…' }) {
  return <div className="state-block" role="status" aria-live="polite">{children}</div>;
}

// Convenience: decide between loading / error / content for a resource entry from the data store.
// `res` is { loading, error } (undefined before first fetch).
export function ResourceGate({ res, onRetry, hasData, children, loadingLabel }) {
  if (res?.error && !hasData) return <ErrorState error={res.error} onRetry={onRetry} />;
  if (res?.loading && !hasData) return <LoadingState>{loadingLabel}</LoadingState>;
  return (
    <>
      {res?.error && hasData && (
        <div className="state-block state-block--error" role="alert" style={{ padding: '8px 12px', flexDirection: 'row', gap: 12 }}>
          <span>Showing last loaded data. Refresh failed: {res.error}</span>
          {onRetry && <button type="button" className="state-block__btn" onClick={onRetry}>Retry</button>}
        </div>
      )}
      {children}
    </>
  );
}
