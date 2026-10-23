import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';
import { wireMessage, withHandlers } from '@/test/ws-frames';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
  apiFetch: apiFetchMock,
}));

type WSHandler = ((ev: unknown) => void) | null;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
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

  simulateMessage(data: string) {
    this.onmessage?.({ data } as unknown);
  }

  simulateOpen() {
    this.onopen?.({} as unknown);
  }

  simulateClose() {
    this.onclose?.({} as unknown);
  }

  simulateError() {
    this.onerror?.({} as unknown);
  }
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

beforeEach(() => {
  MockWebSocket.instances = [];
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ ticket: 'test-ticket' });
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useWebSocket - extra coverage', () => {
  it('calls onChannelUpdated for channel.updated events', async () => {
    const onChannelUpdated = vi.fn();
    renderHook(() => useWebSocket(withHandlers({ onChannelUpdated, enabled: true })));
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'channel.updated',
      data: JSON.stringify({ channelID: 'ch-7' }),
    }));

    expect(onChannelUpdated).toHaveBeenCalledWith({ channelID: 'ch-7' });
  });

  it('calls onChannelNew for channel.new events', async () => {
    const onChannelNew = vi.fn();
    renderHook(() => useWebSocket(withHandlers({ onChannelNew, enabled: true })));
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(JSON.stringify({
      type: 'channel.new',
      data: JSON.stringify({ channelID: 'ch-new' }),
    }));

    expect(onChannelNew).toHaveBeenCalledWith({ channelID: 'ch-new' });
  });

  it('calls onChannelRemoved for channel.removed events', async () => {
    const onChannelRemoved = vi.fn();
    renderHook(() => useWebSocket(withHandlers({ onChannelRemoved, enabled: true })));
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(JSON.stringify({
      type: 'channel.removed',
      data: JSON.stringify({ channelID: 'ch-rm' }),
    }));

    expect(onChannelRemoved).toHaveBeenCalledWith({ channelID: 'ch-rm' });
  });

  it('calls ws.close() on error event', async () => {
    renderHook(() => useWebSocket(withHandlers({ enabled: true })));
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateError();

    expect(ws.closeCalled).toBe(true);
  });

  it('ignores malformed JSON in messages', async () => {
    const onMessageNew = vi.fn();
    renderHook(() => useWebSocket(withHandlers({ onMessageNew, enabled: true })));
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    // Should not throw
    expect(() => ws.simulateMessage('not-json{')).not.toThrow();
    expect(onMessageNew).not.toHaveBeenCalled();
  });

  it('does not reconnect on close when component disabled before close fires', async () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useWebSocket(withHandlers({ enabled })),
      { initialProps: { enabled: true } },
    );
    await flushConnect();

    expect(MockWebSocket.instances).toHaveLength(1);

    // Disable, then close
    rerender({ enabled: false });
    // After disabling, the cleanup will close the socket. We then simulate
    // a stray close on the (now disposed) instance:
    MockWebSocket.instances[0].simulateClose();

    vi.advanceTimersByTime(60_000);
    await flushConnect();
    // No reconnect should have been scheduled
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not connect when there is no token', async () => {
    const mod = await import('@/lib/api');
    const getTokenMock = vi.mocked(mod.getAccessToken);
    getTokenMock.mockReturnValueOnce(null as unknown as string);

    renderHook(() => useWebSocket(withHandlers({ enabled: true })));
    await flushConnect();

    // No token → connect bails before even minting a ticket.
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it.each([
    ['presence.changed', 'onPresenceChanged', { userID: 'u-1', online: true }],
    ['emoji.added', 'onEmojiAdded', { name: ':party:', imageURL: '/e/party.png', createdBy: 'u-1', createdAt: '2026-01-01T00:00:00Z' }],
    ['emoji.removed', 'onEmojiRemoved', { name: ':party:' }],
    ['user.updated', 'onUserUpdated', { id: 'u-1', displayName: 'New' }],
    ['userchannel.updated', 'onUserChannelUpdated', { channelID: 'ch-1', sidebarPosition: 1000 }],
    ['sidebar.updated', 'onSidebarUpdated', { userID: 'u-1' }],
    ['attachment.deleted', 'onAttachmentDeleted', { id: 'a-1' }],
    ['channel.muted', 'onChannelMuted', { channelID: 'ch-1', muted: true }],
    ['notification.new', 'onNotification', { kind: 'message', parentID: 'ch-1', parentType: 'channel', title: 't', body: 'b', deepLink: '/x' }],
    ['auth.force_logout', 'onForceLogout', { reason: 'admin-revoked' }],
    ['server.version', 'onServerVersion', { version: '1.2.3' }],
    ['ping', 'onPing', { ts: 123 }],
    ['typing', 'onTyping', { userID: 'u-1', parentID: 'ch-1' }],
  ] as const)('routes %s events to %s', async (type, cbName, payload) => {
    const cb = vi.fn();
    renderHook(() => useWebSocket(withHandlers({ [cbName]: cb, enabled: true })));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type, data: JSON.stringify(payload) }));
    expect(cb).toHaveBeenCalledWith(payload);
  });

  it('updates the latest callbacks via ref so handlers see fresh closures', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: typeof first }) => useWebSocket(withHandlers({ onMessageNew: cb, enabled: true })),
      { initialProps: { cb: first } },
    );
    await flushConnect();
    rerender({ cb: second });
    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(JSON.stringify({ type: 'message.new', data: JSON.stringify(wireMessage({ id: '1' })) }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(wireMessage({ id: '1' }));
  });

  it('ignores a frame with no event type, and still dedups it by id', async () => {
    const cb = vi.fn();
    renderHook(() => useWebSocket(withHandlers({ onDraftUpdated: cb, enabled: true })));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(JSON.stringify({ id: 'typeless-1', data: '{}' }));
    ws.simulateMessage(JSON.stringify({ id: 'typeless-1', type: 'draft.updated', data: '{}' }));
    // Nothing handled the typeless frame, and its id now dedups the second.
    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores unknown event types', async () => {
    const cb = vi.fn();
    renderHook(() => useWebSocket(withHandlers({ onMessageNew: cb, enabled: true })));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(JSON.stringify({ type: 'pong', data: '{}' }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT call onReconnect on the first successful open', async () => {
    const onReconnect = vi.fn();
    renderHook(() => useWebSocket(withHandlers({ onReconnect, enabled: true })));
    await flushConnect();
    MockWebSocket.instances[0].simulateOpen();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('calls onReconnect when the socket re-opens after a close', async () => {
    const onReconnect = vi.fn();
    renderHook(() => useWebSocket(withHandlers({ onReconnect, enabled: true })));
    await flushConnect();
    const first = MockWebSocket.instances[0];
    first.simulateOpen();
    first.simulateClose();
    // Backoff timer fires → new WebSocket constructed. The delay is jittered
    // (≤30s cap), so a 31s sweep fires it regardless of the draw.
    await act(async () => {
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();
    const second = MockWebSocket.instances[1];
    expect(second).toBeDefined();
    second.simulateOpen();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    // Every connect mints a fresh one-time ticket: initial + reconnect.
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
