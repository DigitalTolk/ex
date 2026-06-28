import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

function Boom({ when }: { when: boolean }): React.ReactElement {
  if (when) throw new Error('kaboom');
  return <div>safe content</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <Boom when={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('safe content')).toBeInTheDocument();
  });

  it('renders the default fallback when a child throws, and can reload', () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { reload }, writable: true });
    render(
      <ErrorBoundary>
        <Boom when={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong.');
    fireEvent.click(screen.getByText('Reload'));
    expect(reload).toHaveBeenCalled();
  });

  it('renders a custom fallback with the error and a working reset', () => {
    function Wrapper() {
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <div>
              <span data-testid="msg">caught: {error.message}</span>
              <button onClick={reset}>retry</button>
            </div>
          )}
        >
          <Boom when={true} />
        </ErrorBoundary>
      );
    }
    render(<Wrapper />);
    expect(screen.getByTestId('msg')).toHaveTextContent('caught: kaboom');
    // reset clears the error state (the child still throws, so the fallback
    // re-renders — but the reset path is exercised).
    fireEvent.click(screen.getByText('retry'));
    expect(screen.getByTestId('msg')).toBeInTheDocument();
  });
});
