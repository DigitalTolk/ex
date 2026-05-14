import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

const refreshAccessTokenMock = vi.hoisted(() => vi.fn());

// Mock getAccessToken
vi.mock('@/lib/api', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
  refreshAccessToken: refreshAccessTokenMock,
}));

// --- WebSocket mock ---
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
    // Simulate async close event on next tick
    if (this.onclose) {
      // Don't auto-fire onclose here to avoid infinite reconnect in tests
    }
  }

  // Helper to simulate server sending a message
  simulateMessage(data: string) {
    this.onmessage?.({ data } as unknown);
  }

  simulateOpen() {
    this.onopen?.({} as unknown);
  }

  simulateClose() {
    this.onclose?.({} as unknown);
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  refreshAccessTokenMock.mockResolvedValue('test-token');
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useWebSocket', () => {
  it('connects with the correct URL', () => {
    renderHook(() =>
      useWebSocket({ enabled: true }),
    );

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('/api/v1/ws?token=test-token');
  });

  it('does not connect when disabled', () => {
    renderHook(() =>
      useWebSocket({ enabled: false }),
    );

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('calls onMessageNew when receiving a message.new event', () => {
    const onMessageNew = vi.fn();
    renderHook(() =>
      useWebSocket({ onMessageNew, enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'message.new',
      data: JSON.stringify({ id: '1', body: 'hello' }),
    }));

    expect(onMessageNew).toHaveBeenCalledWith({ id: '1', body: 'hello' });
  });

  it('calls onMessageEdited when receiving a message.edited event', () => {
    const onMessageEdited = vi.fn();
    renderHook(() =>
      useWebSocket({ onMessageEdited, enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'message.edited',
      data: JSON.stringify({ id: '2', body: 'edited' }),
    }));

    expect(onMessageEdited).toHaveBeenCalledWith({ id: '2', body: 'edited' });
  });

  it('calls onMessageDeleted when receiving a message.deleted event', () => {
    const onMessageDeleted = vi.fn();
    renderHook(() =>
      useWebSocket({ onMessageDeleted, enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'message.deleted',
      data: JSON.stringify({ id: '3' }),
    }));

    expect(onMessageDeleted).toHaveBeenCalledWith({ id: '3' });
  });

  it('handles data as object (not double-encoded string)', () => {
    const onMessageNew = vi.fn();
    renderHook(() =>
      useWebSocket({ onMessageNew, enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    // When data is falsy/missing, falls back to msg itself
    ws.simulateMessage(JSON.stringify({
      type: 'message.new',
    }));

    expect(onMessageNew).toHaveBeenCalledWith({ type: 'message.new' });
  });

  it('tries each reconnect delay three times before advancing', async () => {
    renderHook(() =>
      useWebSocket({ enabled: true }),
    );

    expect(MockWebSocket.instances).toHaveLength(1);

    const attempts = [
      { wait: 1000, early: 999 },
      { wait: 1000, early: 999 },
      { wait: 1000, early: 999 },
      { wait: 2000, early: 1999 },
      { wait: 2000, early: 1999 },
      { wait: 2000, early: 1999 },
      { wait: 4000, early: 3999 },
      { wait: 4000, early: 3999 },
      { wait: 4000, early: 3999 },
      { wait: 8000, early: 7999 },
      { wait: 8000, early: 7999 },
      { wait: 8000, early: 7999 },
      { wait: 16000, early: 15999 },
      { wait: 16000, early: 15999 },
      { wait: 16000, early: 15999 },
      { wait: 30000, early: 29999 },
    ];

    for (const [index, { wait, early }] of attempts.entries()) {
      MockWebSocket.instances[index].simulateClose();
      expect(MockWebSocket.instances).toHaveLength(index + 1);

      await act(async () => {
        vi.advanceTimersByTime(early);
        await Promise.resolve();
      });
      expect(MockWebSocket.instances).toHaveLength(index + 1);

      await act(async () => {
        vi.advanceTimersByTime(wait - early);
        await Promise.resolve();
      });
      expect(MockWebSocket.instances).toHaveLength(index + 2);
      expect(refreshAccessTokenMock).toHaveBeenCalledTimes(index + 1);
    }
  });

  it('resets retry count after successful open', async () => {
    renderHook(() =>
      useWebSocket({ enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    ws.simulateClose();
    await act(async () => {
      vi.advanceTimersByTime(1000); // reconnect
      await Promise.resolve();
    });

    const ws2 = MockWebSocket.instances[1];
    ws2.simulateOpen(); // resets retry count
    ws2.simulateClose();

    // Should use 1000ms backoff again (retry count was reset)
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('calls onMembersChanged when receiving a members.changed event', () => {
    const onMembersChanged = vi.fn();
    renderHook(() =>
      useWebSocket({ onMembersChanged, enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'members.changed',
      data: JSON.stringify({ channelID: 'ch-1' }),
    }));

    expect(onMembersChanged).toHaveBeenCalledWith({ channelID: 'ch-1' });
  });

  it('calls onConversationNew when receiving a conversation.new event', () => {
    const onConversationNew = vi.fn();
    renderHook(() =>
      useWebSocket({ onConversationNew, enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'conversation.new',
      data: JSON.stringify({ conversationID: 'conv-1' }),
    }));

    expect(onConversationNew).toHaveBeenCalledWith({ conversationID: 'conv-1' });
  });

  it('calls onChannelArchived when receiving a channel.archived event', () => {
    const onChannelArchived = vi.fn();
    renderHook(() =>
      useWebSocket({ onChannelArchived, enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'channel.archived',
      data: JSON.stringify({ channelID: 'ch-2' }),
    }));

    expect(onChannelArchived).toHaveBeenCalledWith({ channelID: 'ch-2' });
  });

  it('cleans up on unmount', () => {
    const { unmount } = renderHook(() =>
      useWebSocket({ enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    unmount();

    expect(ws.closeCalled).toBe(true);
  });

  // Reconnect cursor: the last event ID seen on the live socket
  // must be sent as `since=…` on the next reconnect so the server
  // can replay anything missed during the disconnect.
  it('sends the last event id as ?since on reconnect', async () => {
    renderHook(() => useWebSocket({ enabled: true }));

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      id: '01ID0000000000000000000099',
      type: 'message.new',
      data: JSON.stringify({ id: 'm1' }),
    }));
    ws.simulateClose();

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('since=01ID0000000000000000000099');
  });

  // First connect (no prior cursor) must not send a since param —
  // the server interprets that as "fresh, no replay needed".
  it('omits ?since on a fresh first connect', () => {
    renderHook(() => useWebSocket({ enabled: true }));
    expect(MockWebSocket.instances[0].url).not.toContain('since=');
  });

  // Replay + live race: when an event ID arrives twice (once from
  // the durable replay, once from the live pubsub), the callback
  // must fire exactly once. Without dedup the cache would double-
  // apply mutations on every reconnect.
  it('deduplicates events by id across replay + live', () => {
    const onMessageNew = vi.fn();
    renderHook(() => useWebSocket({ onMessageNew, enabled: true }));

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    const frame = JSON.stringify({
      id: '01ID0000000000000000000050',
      type: 'message.new',
      data: JSON.stringify({ id: 'm1' }),
    });
    ws.simulateMessage(frame);
    ws.simulateMessage(frame);

    expect(onMessageNew).toHaveBeenCalledTimes(1);
  });

  // replay.exhausted: server reports our cursor is too old. The
  // hook clears the cursor (so we don't ask again for a hopeless
  // window next reconnect) and fires the onReplayExhausted
  // callback so ChatPage can trigger its full refetch path.
  it('fires onReplayExhausted and resets cursor on replay.exhausted', async () => {
    const onReplayExhausted = vi.fn();
    renderHook(() =>
      useWebSocket({ onReplayExhausted, enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    // Seed the cursor with a live event first.
    ws.simulateMessage(JSON.stringify({
      id: '01ID0000000000000000000077',
      type: 'message.new',
      data: JSON.stringify({ id: 'm1' }),
    }));
    // Now server says that cursor is exhausted.
    ws.simulateMessage(JSON.stringify({
      id: '01ID0000000000000000000078',
      type: 'replay.exhausted',
      data: JSON.stringify({ since: '01ID0000000000000000000077' }),
    }));
    ws.simulateClose();

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(onReplayExhausted).toHaveBeenCalledTimes(1);
    // After exhausted the cursor is cleared — the reconnect must
    // not carry a stale since= that we already know is hopeless.
    expect(MockWebSocket.instances[1].url).not.toContain('since=');
  });

  // replay.done is a marker frame — no callback should fire for it,
  // and (importantly) it should NOT advance the cursor past the
  // last real event, otherwise the next reconnect would miss
  // anything published right after the marker.
  it('ignores replay.done as a no-op marker', () => {
    const onMessageNew = vi.fn();
    renderHook(() => useWebSocket({ onMessageNew, enabled: true }));

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      id: '01ID0000000000000000000010',
      type: 'replay.done',
      data: JSON.stringify({ count: 0 }),
    }));

    expect(onMessageNew).not.toHaveBeenCalled();
  });
});
