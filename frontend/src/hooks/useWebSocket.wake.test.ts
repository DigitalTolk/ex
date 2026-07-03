import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';
import { getAccessToken } from '@/lib/api';

// Wake-probe coverage: foreground/connectivity events must reconnect a gone
// socket immediately (skipping the backoff) and force-close a half-open one
// (no frame for > the stale window despite the server's 15s app-ping).

const refreshAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
  refreshAccessToken: refreshAccessTokenMock,
}));

type WSHandler = ((ev: unknown) => void) | null;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: WSHandler = null;
  onmessage: WSHandler = null;
  onclose: WSHandler = null;
  onerror: WSHandler = null;
  closeCalled = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.closeCalled = true;
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as unknown);
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data } as unknown);
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as unknown);
  }
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
}

async function wake(event = 'focus') {
  await act(async () => {
    // The hook listens for visibilitychange on document, the rest on window.
    (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
    await Promise.resolve();
  });
}

beforeEach(() => {
  MockWebSocket.instances = [];
  // restoreAllMocks only touches spies, not vi.fn() — reset explicitly so
  // call history and once-implementations never leak across tests.
  refreshAccessTokenMock.mockReset();
  refreshAccessTokenMock.mockResolvedValue('test-token');
  vi.mocked(getAccessToken).mockReset();
  vi.mocked(getAccessToken).mockReturnValue('test-token');
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useWebSocket wake probe', () => {
  it('reconnects immediately on wake when the socket is gone, skipping the pending backoff', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateClose();
    });
    // A 1s backoff retry is now pending — the wake must not wait for it.
    await wake('focus');
    expect(MockWebSocket.instances).toHaveLength(2);
    // The cancelled backoff timer must not fire a THIRD connect.
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('force-closes a half-open socket (no frames past the stale window) so onclose reconnects', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
    });
    // The OS suspended the app; no frames (not even the 15s server ping)
    // arrive for 46s, then the app comes back to the foreground.
    vi.setSystemTime(Date.now() + 46_000);
    await wake('visibilitychange');
    expect(MockWebSocket.instances[0].closeCalled).toBe(true);
  });

  it('leaves a fresh OPEN socket alone on wake', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateMessage(JSON.stringify({ type: 'ping' }));
    });
    vi.setSystemTime(Date.now() + 10_000);
    await wake('pageshow');
    expect(MockWebSocket.instances[0].closeCalled).toBe(false);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does nothing while the document is hidden', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateClose();
    });
    setVisibility('hidden');
    await wake('visibilitychange');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('lets an in-flight CONNECTING socket finish instead of racing a second connect', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    // Still CONNECTING (never opened).
    await wake('online');
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].closeCalled).toBe(false);
  });

  it('coalesces overlapping wake reconnects while the token refresh is pending', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateClose();
    });
    let release: (token: string) => void = () => {};
    refreshAccessTokenMock.mockImplementationOnce(
      () => new Promise<string>((resolve) => { release = resolve; }),
    );
    await wake('focus');
    await wake('focus');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      release('test-token');
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('connects on wake when the initial mount had no token yet', async () => {
    vi.mocked(getAccessToken).mockReturnValueOnce(null);
    renderHook(() => useWebSocket({ enabled: true }));
    expect(MockWebSocket.instances).toHaveLength(0);
    // No socket AND no pending backoff timer — the wake is the only trigger.
    await wake('focus');
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
