import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';
import { withHandlers } from '@/test/ws-frames';

// Session renewal: a socket lives as long as the token its ticket was minted
// with (plus a server grace). Shortly before that the client mints a fresh
// ticket and sends it over the socket, so a healthy socket stays open instead
// of being closed and reopened — with a full refetch — every token lifetime.

const api = vi.hoisted(() => ({ apiFetch: vi.fn(), refreshAccessToken: vi.fn() }));
const notifyAuthInvalid = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
  apiFetch: api.apiFetch,
  refreshAccessToken: api.refreshAccessToken,
}));
vi.mock('@/lib/auth-events', () => ({ notifyAuthInvalid }));

type WSHandler = ((ev: unknown) => void) | null;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: WSHandler = null;
  onmessage: WSHandler = null;
  onclose: WSHandler = null;
  onerror: WSHandler = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(frame: string) {
    this.sent.push(frame);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as unknown);
  }

  simulateMessage(type: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ id: `01E${type}`, type, data }) } as unknown);
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as unknown);
  }
}

const MIN = 60_000;

// Settle the promise chains the hook awaits (ticket mint, token refresh).
async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await settle();
}

const renewFrames = (ws: MockWebSocket) =>
  ws.sent.map((f) => JSON.parse(f) as { type: string; ticket?: string }).filter((f) => f.type === 'session.renew');

// expiresIn null: the ticket answer of a server that predates renewal.
async function openSocket(expiresIn: number | null = 10 * MIN) {
  api.apiFetch.mockResolvedValueOnce(expiresIn === null ? { ticket: 'connect-ticket' } : { ticket: 'connect-ticket', expiresIn });
  const hook = renderHook(() => useWebSocket(withHandlers({ enabled: true })));
  await settle();
  const ws = MockWebSocket.instances[0];
  ws.simulateOpen();
  return { ws, hook };
}

beforeEach(() => {
  MockWebSocket.instances = [];
  api.apiFetch.mockReset();
  api.refreshAccessToken.mockReset();
  api.refreshAccessToken.mockResolvedValue('fresh-token');
  notifyAuthInvalid.mockReset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useWebSocket session renewal', () => {
  it('renews over the open socket before it expires, then from each confirmation', async () => {
    const { ws } = await openSocket(10 * MIN);

    await advance(8 * MIN - 1);
    expect(api.refreshAccessToken).not.toHaveBeenCalled();

    // Two minutes ahead: a forced token refresh (so the new ticket carries a
    // new token's expiry), a ticket, and the renew frame on the same socket.
    api.apiFetch.mockResolvedValueOnce({ ticket: 'renew-1', expiresIn: 16 * MIN });
    await advance(1);
    expect(api.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(api.apiFetch).toHaveBeenLastCalledWith('/api/v1/ws/ticket', { method: 'POST' });
    expect(renewFrames(ws)).toEqual([{ type: 'session.renew', ticket: 'renew-1' }]);
    expect(MockWebSocket.instances).toHaveLength(1);

    // The server's confirmation books the next renewal from the new lifetime.
    act(() => ws.simulateMessage('session.renewed', { expiresIn: 16 * MIN }));
    api.apiFetch.mockResolvedValueOnce({ ticket: 'renew-2', expiresIn: 16 * MIN });
    await advance(14 * MIN - 1);
    expect(renewFrames(ws)).toHaveLength(1);
    await advance(1);
    expect(renewFrames(ws)).toEqual([
      { type: 'session.renew', ticket: 'renew-1' },
      { type: 'session.renew', ticket: 'renew-2' },
    ]);
  });

  it('books nothing more without a confirmation, so the socket closes at its deadline as before', async () => {
    const { ws } = await openSocket(10 * MIN);
    api.apiFetch.mockResolvedValueOnce({ ticket: 'renew-1' });
    await advance(8 * MIN);
    expect(renewFrames(ws)).toHaveLength(1);

    // A malformed confirmation books nothing either.
    act(() => ws.simulateMessage('session.renewed', { expiresIn: 'soon' }));
    await advance(60 * MIN);
    expect(api.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('logs out when the session was rejected, instead of waiting for the socket to die', async () => {
    const { ws } = await openSocket(10 * MIN);
    api.refreshAccessToken.mockResolvedValueOnce(null);
    await advance(8 * MIN);
    expect(notifyAuthInvalid).toHaveBeenCalledTimes(1);
    expect(api.apiFetch).toHaveBeenCalledTimes(1); // only the connect mint
    expect(renewFrames(ws)).toHaveLength(0);
  });

  it('skips the renewal on a network failure, leaving the reconnect path to recover', async () => {
    const first = await openSocket(10 * MIN);
    api.refreshAccessToken.mockRejectedValueOnce(new Error('offline'));
    await advance(8 * MIN);
    expect(renewFrames(first.ws)).toHaveLength(0);
    expect(notifyAuthInvalid).not.toHaveBeenCalled();
    first.hook.unmount();

    MockWebSocket.instances = [];
    const second = await openSocket(10 * MIN);
    api.apiFetch.mockRejectedValueOnce(new Error('offline'));
    await advance(8 * MIN);
    expect(renewFrames(second.ws)).toHaveLength(0);
    second.hook.unmount();

    MockWebSocket.instances = [];
    const third = await openSocket(10 * MIN);
    api.apiFetch.mockResolvedValueOnce(undefined);
    await advance(8 * MIN);
    expect(renewFrames(third.ws)).toHaveLength(0);
  });

  it('sends nothing to a socket that closed while the renewal was minting', async () => {
    const { ws } = await openSocket(10 * MIN);
    let refreshed!: (token: string) => void;
    api.refreshAccessToken.mockReturnValueOnce(new Promise<string>((resolve) => (refreshed = resolve)));
    api.apiFetch.mockResolvedValueOnce({ ticket: 'late' });
    await advance(8 * MIN);
    act(() => ws.simulateClose());
    refreshed('fresh-token');
    await settle();
    expect(renewFrames(ws)).toHaveLength(0);
  });

  it('books no renewal against a server that does not report the lifetime', async () => {
    const { ws } = await openSocket(null);
    await advance(60 * MIN);
    expect(api.refreshAccessToken).not.toHaveBeenCalled();
    expect(renewFrames(ws)).toHaveLength(0);
  });

  it('drops a pending renewal when the socket closes or the hook unmounts', async () => {
    const first = await openSocket(10 * MIN);
    act(() => first.ws.simulateClose());
    first.hook.unmount();
    MockWebSocket.instances = [];
    const second = await openSocket(10 * MIN);
    second.hook.unmount();
    await advance(60 * MIN);
    expect(api.refreshAccessToken).not.toHaveBeenCalled();
  });
});
