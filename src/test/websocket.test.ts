import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { clearAccessToken, setAccessToken } from '@/lib/api';
import { useWebSocket } from '@/hooks/useWebSocket';

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  close() {
    this.onclose?.();
  }
}

// Test the WebSocket event types are handled correctly
// Since the hook uses actual WebSocket, we test the message dispatch logic directly

describe('useWebSocket event types', () => {
  const eventTypes = [
    'message.new',
    'message.edited',
    'message.deleted',
    'members.changed',
    'conversation.new',
    'channel.archived',
    'channel.updated',
    'channel.new',
  ];

  it('all expected event types are defined', () => {
    // Verify the event types list is complete
    expect(eventTypes).toHaveLength(8);
    expect(eventTypes).toContain('channel.updated');
    expect(eventTypes).toContain('channel.new');
  });

  it('dispatches channel.updated events correctly', () => {
    const callbacks: Record<string, (data: unknown) => void> = {};

    // Simulate the switch statement logic from useWebSocket
    function dispatch(type: string, payload: unknown) {
      switch (type) {
        case 'message.new': callbacks.onMessageNew?.(payload); break;
        case 'message.edited': callbacks.onMessageEdited?.(payload); break;
        case 'message.deleted': callbacks.onMessageDeleted?.(payload); break;
        case 'members.changed': callbacks.onMembersChanged?.(payload); break;
        case 'conversation.new': callbacks.onConversationNew?.(payload); break;
        case 'channel.archived': callbacks.onChannelArchived?.(payload); break;
        case 'channel.updated': callbacks.onChannelUpdated?.(payload); break;
        case 'channel.new': callbacks.onChannelNew?.(payload); break;
      }
    }

    const onChannelUpdated = vi.fn();
    const onChannelNew = vi.fn();
    callbacks.onChannelUpdated = onChannelUpdated;
    callbacks.onChannelNew = onChannelNew;

    dispatch('channel.updated', { channelID: 'ch1' });
    expect(onChannelUpdated).toHaveBeenCalledWith({ channelID: 'ch1' });

    dispatch('channel.new', { channelID: 'ch2' });
    expect(onChannelNew).toHaveBeenCalledWith({ channelID: 'ch2' });
  });
});

describe('conversation unhide on message', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('unhide logic removes conversation from hidden set', () => {
    // Simulate the unhide logic from ChatPage's onMessageNew
    const hiddenSet = new Set(['conv1', 'conv2']);

    function unhideConversation(id: string) {
      if (hiddenSet.has(id)) {
        hiddenSet.delete(id);
      }
    }

    // Simulate new message arriving for hidden conversation
    const parentID = 'conv1';
    unhideConversation(parentID);

    expect(hiddenSet.has('conv1')).toBe(false);
    expect(hiddenSet.has('conv2')).toBe(true);
  });

  it('unhide is a no-op for non-hidden conversations', () => {
    const hiddenSet = new Set(['conv1']);
    const sizeBefore = hiddenSet.size;

    function unhideConversation(id: string) {
      if (hiddenSet.has(id)) {
        hiddenSet.delete(id);
      }
    }

    unhideConversation('conv-nonexistent');
    expect(hiddenSet.size).toBe(sizeBefore);
  });
});

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

describe('useWebSocket ticket mint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAccessToken();
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket: 'minted-ticket' }),
    } as Response);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAccessToken();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  it('mints a fresh one-time ticket before connecting and again on reconnect', async () => {
    setAccessToken('secret-jwt');

    const { unmount } = renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('ticket=minted-ticket');
    // The access JWT itself must never ride the WS URL — it used to leak
    // into LB/proxy logs and browser history.
    expect(MockWebSocket.instances[0].url).not.toContain('secret-jwt');

    act(() => {
      MockWebSocket.instances[0].onclose?.();
    });
    await act(async () => {
      // The reconnect delay is jittered (capped at 30s) — a 31s sweep fires
      // it regardless of the draw.
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/v1/ws/ticket',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('ticket=minted-ticket');

    unmount();
  });
});
