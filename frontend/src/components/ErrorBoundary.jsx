import { Component } from 'react';

// Catches render errors in a subtree and offers a retry. Used once at the root and once per routed page.
// `resetKey` (e.g. the pathname) clears the error when the user navigates elsewhere.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', this.props.label || 'app', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  retry() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          color: 'var(--v2-text-primary)',
          padding: 40,
          fontFamily: 'var(--v2-font-data)',
          fontSize: 14,
          maxWidth: 900,
        }}
      >
        <h1 style={{ color: 'var(--v2-accent-cyan)', fontSize: 20, marginBottom: 12 }}>
          {this.props.label ? `${this.props.label} crashed` : 'GRID — something went wrong'}
        </h1>
        <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--v2-accent-red)' }}>{error.message}</pre>
        <button
          type="button"
          onClick={this.retry}
          style={{
            marginTop: 16,
            padding: '8px 16px',
            border: '1px solid var(--v2-accent-cyan)',
            borderRadius: 'var(--v2-radius-sm)',
            color: 'var(--v2-accent-cyan)',
            fontFamily: 'inherit',
          }}
        >
          Try again
        </button>
        {import.meta.env.DEV && (
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 16, color: 'var(--v2-text-muted)', fontSize: 11 }}>
            {error.stack}
          </pre>
        )}
      </div>
    );
  }
}
