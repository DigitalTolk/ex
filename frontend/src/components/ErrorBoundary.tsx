import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  // Optional custom fallback; defaults to a minimal reload card. A render
  // function receives the error so callers can show details if they want.
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

// ErrorBoundary contains a render-time exception to a fallback UI instead of
// letting it unmount the whole React tree to a blank screen. For an incident
// tool, a single malformed message (e.g. one that trips the markdown renderer)
// must not take down the entire client — the rest of the app keeps working and
// the user can retry.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface it for telemetry/console rather than swallowing silently.
    console.error('ErrorBoundary caught a render error', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm font-semibold text-foreground">Something went wrong.</p>
          <p className="max-w-md text-xs text-muted-foreground">
            An unexpected error broke this view. The rest of the app is still running.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
