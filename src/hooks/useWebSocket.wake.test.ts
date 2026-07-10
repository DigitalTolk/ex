import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';
import { getAccessToken } from '@/lib/api';

// Wake-probe coverage: foreground/connectivity events must reconnect a gone
// socket immediately (skipping the backoff — even while hidden, so a
// background 'online' revives delivery) and force-close a half-open one
// (no frame for > the stale window despite the server's 15s app-ping).

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
  apiFetch: apiFetchMock,
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

// connect() awaits the ticket mint before constructing the socket, so socket
// creation is asynchronous — flush the microtask chain (mint → ticket →
// new WebSocket) before asserting on MockWebSocket.instances.
async function flushConnect() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function wake(event = 'focus') {
  await act(async () => {
    // The hook listens for visibilitychange on document, the rest on window.
    (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
    await Promise.resolve();
  });
  // A gone-socket probe reconnects through the async ticket mint — settle it.
  await flushConnect();
}

beforeEach(() => {
  MockWebSocket.instances = [];
  // restoreAllMocks only touches spies, not vi.fn() — reset explicitly so
  // call history and once-implementations never leak across tests.
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ ticket: 'test-ticket' });
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
    await flushConnect();
    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateClose();
    });
    // A jittered backoff retry is now pending — the wake must not wait for it.
    await wake('focus');
    expect(MockWebSocket.instances).toHaveLength(2);
    // The cancelled backoff timer must not fire a THIRD connect — a 31s
    // sweep covers any delay the jitter could have drawn (cap is 30s).
    await act(async () => {
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('force-closes a half-open socket (no frames past the stale window) so onclose reconnects', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();
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
    await flushConnect();
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateMessage(JSON.stringify({ type: 'ping' }));
    });
    vi.setSystemTime(Date.now() + 10_000);
    await wake('pageshow');
    expect(MockWebSocket.instances[0].closeCalled).toBe(false);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('reconnects a gone socket even while the document is hidden', async () => {
    // A background 'online' event used to be ignored while hidden, leaving
    // the tab dark (and its notifications dead) until it was foregrounded.
    // A GONE socket must revive delivery regardless of visibility.
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateClose();
    });
    setVisibility('hidden');
    await wake('online');
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('defers the half-open force-close while the document is hidden', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
    });
    // The stale window elapsed, but the tab is still hidden: background
    // timers are throttled and the close→reconnect churn buys nothing until
    // the user can see the tab again — the probe must leave it alone.
    vi.setSystemTime(Date.now() + 46_000);
    setVisibility('hidden');
    await wake('visibilitychange');
    expect(MockWebSocket.instances[0].closeCalled).toBe(false);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('lets an in-flight CONNECTING socket finish instead of racing a second connect', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();
    // Still CONNECTING (never opened).
    await wake('online');
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].closeCalled).toBe(false);
  });

  it('coalesces overlapping wake reconnects while the ticket mint is pending', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateClose();
    });
    let release: (res: { ticket: string }) => void = () => {};
    apiFetchMock.mockImplementationOnce(
      () => new Promise<{ ticket: string }>((resolve) => { release = resolve; }),
    );
    await wake('focus');
    await wake('focus');
    // One mint for the initial mount, ONE for both wakes — the in-flight
    // latch coalesces the overlapping probes.
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      release({ ticket: 'test-ticket' });
      await Promise.resolve();
    });
    await flushConnect();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('recovers reconnection after a network-failed wake mint instead of wedging', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateClose();
    });
    // The wake fires while the network is still down: the pre-connect
    // ticket mint fails at the network level.
    apiFetchMock.mockRejectedValueOnce(new Error('offline'));
    await wake('focus');
    expect(MockWebSocket.instances).toHaveLength(1);
    // Regression: the failed mint used to leave the connect-in-flight
    // latch stuck true, permanently disabling reconnection. It must instead
    // book a backoff retry that succeeds once the network is back — fired
    // with a 31s sweep since the jittered delay is never exact.
    await act(async () => {
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();
    // Initial mount + failed wake mint + backoff retry.
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('does not book a reconnect when the hook unmounts while the wake mint is failing', async () => {
    const { unmount } = renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateClose();
    });
    let rejectMint: (err: Error) => void = () => {};
    apiFetchMock.mockImplementationOnce(
      () => new Promise<{ ticket: string }>((_resolve, reject) => { rejectMint = reject; }),
    );
    await wake('focus');
    unmount();
    // The mint fails only AFTER dispose — no backoff retry may be booked
    // for an unmounted hook.
    await act(async () => {
      rejectMint(new Error('offline'));
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await flushConnect();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('connects on wake when the initial mount had no token yet', async () => {
    vi.mocked(getAccessToken).mockReturnValueOnce(null);
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();
    expect(MockWebSocket.instances).toHaveLength(0);
    // No socket AND no pending backoff timer — the wake is the only trigger.
    await wake('focus');
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
