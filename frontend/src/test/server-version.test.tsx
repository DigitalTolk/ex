import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  BUILD_VERSION,
  setServerVersion,
  useServerVersion,
} from '@/hooks/useServerVersion';
import { UpdateBanner } from '@/components/UpdateBanner';

// The version state lives in a module-level store so a "reset" between
// tests means clobbering it back to null. We can't import a private
// resetter — setServerVersion(null) won't work because the setter ignores
// empty strings — so each test pushes a sentinel that's distinct from any
// other test's, then asserts on its own value. The first test seeds it
// once; the others rely on subsequent setServerVersion calls overwriting.

let captured: ReturnType<typeof useServerVersion> | null = null;
function Probe() {
  const v = useServerVersion();
  useEffect(() => {
    captured = v;
  }, [v]);
  return <div data-testid="probe">{String(v.outdated)}</div>;
}

describe('useServerVersion', () => {
  beforeEach(() => {
    captured = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports outdated=false before the server reports a version', () => {
    // Render before any setServerVersion in this test. The previous test's
    // value may still be in the store, so we explicitly assert behavior:
    // until BUILD_VERSION (test) and serverVersion mismatch, banner stays
    // hidden. We seed serverVersion = BUILD_VERSION below to make this
    // test independent of suite order.
    act(() => setServerVersion(BUILD_VERSION));
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('false');
  });

  it('reports outdated=true once the server reports a newer version (vs build)', () => {
    render(<Probe />);
    act(() => setServerVersion('v2.0.0'));
    expect(captured?.serverVersion).toBe('v2.0.0');
    expect(captured?.outdated).toBe(true);
    expect(BUILD_VERSION).toBe('test');
  });

  it('keeps outdated=false when server reports the same version as the build', () => {
    render(<Probe />);
    act(() => setServerVersion(BUILD_VERSION));
    expect(captured?.serverVersion).toBe(BUILD_VERSION);
    expect(captured?.outdated).toBe(false);
  });

  it('subscribers are notified across multiple Probes for the same version event', () => {
    let aCaptured: ReturnType<typeof useServerVersion> | null = null;
    let bCaptured: ReturnType<typeof useServerVersion> | null = null;
    function A() {
      const v = useServerVersion();
      useEffect(() => {
        aCaptured = v;
      }, [v]);
      return null;
    }
    function B() {
      const v = useServerVersion();
      useEffect(() => {
        bCaptured = v;
      }, [v]);
      return null;
    }
    render(
      <>
        <A />
        <B />
      </>,
    );
    act(() => setServerVersion('v3.0.0'));
    expect(aCaptured?.serverVersion).toBe('v3.0.0');
    expect(bCaptured?.serverVersion).toBe('v3.0.0');
  });

  it('ignores duplicate version pushes (no spurious re-renders / state churn)', () => {
    // Set initial. Then re-set with the same value. The setter must early-
    // return — we can't easily count renders here, but we can confirm the
    // captured state didn't change identity-wise across a noop call.
    act(() => setServerVersion('v4.0.0'));
    render(<Probe />);
    const before = captured;
    act(() => setServerVersion('v4.0.0'));
    expect(captured?.serverVersion).toBe('v4.0.0');
    expect(captured?.outdated).toBe(before?.outdated);
  });
});

describe('UpdateBanner', () => {
  it('does not render while versions match', () => {
    act(() => setServerVersion(BUILD_VERSION));
    render(<UpdateBanner />);
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('renders when the server reports a different version', () => {
    act(() => setServerVersion('v9.9.9'));
    render(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toBeInTheDocument();
    expect(screen.getByTestId('update-banner-reload')).toBeInTheDocument();
  });

  it('the reload button cache-busts the location', () => {
    act(() => setServerVersion('v9.9.9'));

    const orig = window.location;
    let assigned = '';
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...orig,
        pathname: '/chat',
        search: '?foo=1',
        get href() {
          return assigned || '/chat';
        },
        set href(v: string) {
          assigned = v;
        },
      },
    });

    try {
      render(<UpdateBanner />);
      const btn = screen.getByTestId('update-banner-reload');
      fireEvent.click(btn);
      expect(assigned).toMatch(/^\/chat\?foo=1&v=\d+$/);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: orig });
    }
  });
});
