import { Component } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';
import { Button } from './Button';

/**
 * Class-based error boundary. React only supports catching render/lifecycle
 * errors via class lifecycle methods, so this cannot be a hook.
 *
 * Note: this does NOT catch errors thrown in async callbacks or event handlers
 * — only errors thrown during rendering of its child tree.
 */
class ErrorBoundaryInner extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    // Log for diagnostics. In production, avoid surfacing stack traces to the UI.
    if (import.meta.env.DEV) {
      console.error('ErrorBoundary caught an error:', error, errorInfo);
    } else {
      console.error('ErrorBoundary caught an error:', error?.message);
    }
  }

  componentDidUpdate(prevProps) {
    // Reset the boundary when the route changes so navigating away recovers.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  handleReset() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-5 p-6 text-center text-gray-100">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600/10 border border-red-600/30">
          <AlertTriangle className="h-7 w-7 text-red-400" />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-gray-100">Something went wrong</h1>
          <p className="max-w-md text-sm text-gray-400">
            This page hit an unexpected error. You can retry, or head back to your agents.
          </p>
        </div>

        {import.meta.env.DEV && (
          <details className="max-w-lg w-full text-left">
            <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300">
              Error details
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-[#1a1d27] border border-gray-800 p-3 text-xs text-red-300 whitespace-pre-wrap break-words">
              {error?.stack || error?.message || String(error)}
            </pre>
          </details>
        )}

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button variant="secondary" onClick={this.handleReset}>
            <RotateCcw className="h-4 w-4" />
            Try again
          </Button>
          <Button variant="primary" onClick={() => { window.location.href = '/'; }}>
            <Home className="h-4 w-4" />
            Go to agents
          </Button>
        </div>
      </div>
    );
  }
}

/**
 * Wrapper that keys the boundary to the current pathname so a page-specific
 * crash clears itself when the user navigates to a different route.
 */
export function ErrorBoundary({ children }) {
  const location = useLocation();
  return (
    <ErrorBoundaryInner resetKey={location.pathname}>
      {children}
    </ErrorBoundaryInner>
  );
}
