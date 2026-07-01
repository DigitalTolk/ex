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

  it('uses the wss scheme when the page is served over https', () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { protocol: 'https:', host: original.host },
    });
    try {
      renderHook(() => useWebSocket({ enabled: true }));
      expect(MockWebSocket.instances[0].url.startsWith('wss://')).toBe(true);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
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

  it('evicts the oldest seen event id once the dedup window overflows', () => {
    const onMessageNew = vi.fn();
    renderHook(() =>
      useWebSocket({ onMessageNew, enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    // Push 513 distinct envelope IDs (dedupCapacity is 512) so the FIFO sheds
    // its oldest entry — exercising the eviction branch.
    for (let i = 0; i < 513; i += 1) {
      ws.simulateMessage(JSON.stringify({
        type: 'message.new',
        id: `evt-${i}`,
        data: JSON.stringify({ id: String(i), body: 'x' }),
      }));
    }
    expect(onMessageNew).toHaveBeenCalledTimes(513);

    // evt-0 was evicted, so re-delivering it is treated as new (not a dup).
    ws.simulateMessage(JSON.stringify({
      type: 'message.new',
      id: 'evt-0',
      data: JSON.stringify({ id: '0', body: 'again' }),
    }));
    expect(onMessageNew).toHaveBeenCalledTimes(514);
  });

  it('does not commit dedup/cursor when a handler throws, so a durable event survives for replay', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // First delivery throws; the second (re-delivery of the same id) succeeds.
    const onMessageNew = vi.fn().mockImplementationOnce(() => {
      throw new Error('cache patch boom');
    });
    renderHook(() => useWebSocket({ onMessageNew, enabled: true }));

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    const frame = JSON.stringify({
      type: 'message.new',
      id: 'evt-throw',
      data: JSON.stringify({ id: 'x', body: 'hi' }),
    });

    // Handler throws → the event must NOT be recorded as seen.
    ws.simulateMessage(frame);
    expect(onMessageNew).toHaveBeenCalledTimes(1);

    // Re-delivering the SAME id is treated as new (not swallowed by dedup), so
    // the durable event is delivered rather than lost.
    ws.simulateMessage(frame);
    expect(onMessageNew).toHaveBeenCalledTimes(2);
    debugSpy.mockRestore();
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

  it('aborts a reconnect when the token refresh comes back empty', async () => {
    // On reconnect the hook refreshes the token first. If the refresh
    // returns no token (session fully expired), the connect attempt must
    // bail out and NOT open a new socket.
    refreshAccessTokenMock.mockResolvedValue('');
    renderHook(() => useWebSocket({ enabled: true }));

    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].simulateClose();

    await act(async () => {
      vi.advanceTimersByTime(1000); // fire the reconnect timer
      await Promise.resolve();
    });

    // refreshAccessToken returned '' → the connect attempt bailed at the
    // `if (!token) return` guard, so no new socket was ever created.
    expect(refreshAccessTokenMock).toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(1);
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

  // Cursor must be monotonic: an out-of-order live frame with a SMALLER ULID
  // (e.g. raced in from another instance) must not move the cursor backwards,
  // or the next reconnect would replay the in-between window and re-deliver.
  it('does not regress the reconnect cursor on an out-of-order frame', async () => {
    renderHook(() => useWebSocket({ enabled: true }));

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      id: '01ID0000000000000000000099',
      type: 'message.new',
      data: JSON.stringify({ id: 'm1' }),
    }));
    // A later frame carrying a smaller id (clock skew / cross-instance order).
    ws.simulateMessage(JSON.stringify({
      id: '01ID0000000000000000000042',
      type: 'message.new',
      data: JSON.stringify({ id: 'm2' }),
    }));
    ws.simulateClose();

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('since=01ID0000000000000000000099');
    expect(MockWebSocket.instances[1].url).not.toContain('since=01ID0000000000000000000042');
  });

  // An EPHEMERAL frame (presence/typing/notification.new) is never replayed, so
  // it must not advance the cursor — even with a higher ULID than a durable
  // message — or a reconnect would skip replaying messages between them.
  it('does not advance the reconnect cursor for an ephemeral frame', async () => {
    renderHook(() => useWebSocket({ enabled: true }));

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      id: '01ID0000000000000000000099',
      type: 'message.new',
      data: JSON.stringify({ id: 'm1' }),
    }));
    ws.simulateMessage(JSON.stringify({
      id: '01ID0000000000000000000150',
      type: 'presence.changed',
      data: JSON.stringify({ userID: 'u1' }),
    }));
    ws.simulateClose();

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(MockWebSocket.instances[1].url).toContain('since=01ID0000000000000000000099');
    expect(MockWebSocket.instances[1].url).not.toContain('since=01ID0000000000000000000150');
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

  // A transport error routes through onerror → ws.close(), which hands off to
  // the standard onclose backoff path (the mock does not auto-fire onclose, so
  // we assert the close was requested).
  it('closes the socket when the underlying connection errors', () => {
    renderHook(() => useWebSocket({ enabled: true }));

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    (ws.onerror as (e: unknown) => void)({});

    expect(ws.closeCalled).toBe(true);
  });

  // Full lifecycle in one flow: connect → durable event advances the replay
  // cursor → the socket drops repeatedly and the backoff ramps 1s×3 → 2s (3
  // attempts per step) with the cursor preserved on every reconnect URL → a
  // successful open resets the retry counter, proven by the next drop backing
  // off at 1s again instead of continuing the ramp.
  it('runs a full connect → backoff → reconnect → reset lifecycle preserving the replay cursor', async () => {
    renderHook(() => useWebSocket({ enabled: true }));

    // Step 1: initial connect + a durable message.new advances lastEventId.
    const ws0 = MockWebSocket.instances[0];
    ws0.simulateOpen();
    ws0.simulateMessage(JSON.stringify({
      id: '01ID0000000000000000000100',
      type: 'message.new',
      data: JSON.stringify({ id: 'm1' }),
    }));

    // Step 2: the socket keeps dropping without ever re-opening → the retry
    // counter climbs and the backoff steps 1s,1s,1s,2s.
    const backoffs = [1000, 1000, 1000, 2000];
    for (const [i, delay] of backoffs.entries()) {
      MockWebSocket.instances[i].simulateClose();

      // Just under the delay → the reconnect timer has NOT fired yet.
      await act(async () => {
        vi.advanceTimersByTime(delay - 1);
        await Promise.resolve();
      });
      expect(MockWebSocket.instances).toHaveLength(i + 1);

      // Crossing the delay → the next socket opens.
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(MockWebSocket.instances).toHaveLength(i + 2);

      // Every reconnect carries the preserved cursor so the server can replay.
      expect(MockWebSocket.instances[i + 1].url).toContain('since=01ID0000000000000000000100');
    }

    // Step 3: the latest socket opens successfully → retryCount resets to 0.
    const reconnected = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    reconnected.simulateOpen();

    // Step 4: it drops again → the backoff is back at the FIRST step (1s),
    // proving the reset (a non-reset counter would still be at ≥2s).
    const beforeReset = MockWebSocket.instances.length;
    reconnected.simulateClose();
    await act(async () => {
      vi.advanceTimersByTime(999);
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(beforeReset);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(beforeReset + 1);
    // The cursor is still preserved after the reset-and-reconnect.
    expect(MockWebSocket.instances[beforeReset].url).toContain('since=01ID0000000000000000000100');
  });
});
