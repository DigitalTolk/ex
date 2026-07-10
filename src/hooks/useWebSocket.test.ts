import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';
import { sendWS } from '@/lib/ws-sender';

const apiFetchMock = vi.hoisted(() => vi.fn());

// Mock getAccessToken + the pre-connect ticket mint
vi.mock('@/lib/api', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
  apiFetch: apiFetchMock,
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
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(frame: string) {
    this.sent.push(frame);
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

describe('useWebSocket', () => {
  it('connects with the correct URL', async () => {
    renderHook(() =>
      useWebSocket({ enabled: true }),
    );
    await flushConnect();

    expect(MockWebSocket.instances).toHaveLength(1);
    // The access JWT never rides the WS URL — only the one-time ticket does.
    expect(MockWebSocket.instances[0].url).toContain('/api/v1/ws?ticket=test-ticket');
  });

  it('does not connect when disabled', async () => {
    renderHook(() =>
      useWebSocket({ enabled: false }),
    );
    await flushConnect();

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('uses the wss scheme when the page is served over https', async () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { protocol: 'https:', host: original.host },
    });
    try {
      renderHook(() => useWebSocket({ enabled: true }));
      await flushConnect();
      expect(MockWebSocket.instances[0].url.startsWith('wss://')).toBe(true);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('installs the shared ws-sender on open so components can send frames', async () => {
    // onopen exposes the live socket's send via setWSSender — typing pings
    // and notification acks route through this without prop-drilling. The
    // installed sender must write to the socket that just opened.
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    sendWS({ type: 'typing', channelID: 'ch-1' });

    expect(ws.sent).toEqual([JSON.stringify({ type: 'typing', channelID: 'ch-1' })]);
  });

  it('calls onMessageNew when receiving a message.new event', async () => {
    const onMessageNew = vi.fn();
    renderHook(() =>
      useWebSocket({ onMessageNew, enabled: true }),
    );
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'message.new',
      data: JSON.stringify({ id: '1', body: 'hello' }),
    }));

    expect(onMessageNew).toHaveBeenCalledWith({ id: '1', body: 'hello' });
  });

  it('calls onMessageEdited when receiving a message.edited event', async () => {
    const onMessageEdited = vi.fn();
    renderHook(() =>
      useWebSocket({ onMessageEdited, enabled: true }),
    );
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'message.edited',
      data: JSON.stringify({ id: '2', body: 'edited' }),
    }));

    expect(onMessageEdited).toHaveBeenCalledWith({ id: '2', body: 'edited' });
  });

  it('calls onMessageDeleted when receiving a message.deleted event', async () => {
    const onMessageDeleted = vi.fn();
    renderHook(() =>
      useWebSocket({ onMessageDeleted, enabled: true }),
    );
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'message.deleted',
      data: JSON.stringify({ id: '3' }),
    }));

    expect(onMessageDeleted).toHaveBeenCalledWith({ id: '3' });
  });

  it('evicts the oldest seen event id once the dedup window overflows', async () => {
    const onMessageNew = vi.fn();
    renderHook(() =>
      useWebSocket({ onMessageNew, enabled: true }),
    );
    await flushConnect();

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

  it('does not commit dedup/cursor when a handler throws, so a durable event survives for replay', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // First delivery throws; the second (re-delivery of the same id) succeeds.
    const onMessageNew = vi.fn().mockImplementationOnce(() => {
      throw new Error('cache patch boom');
    });
    renderHook(() => useWebSocket({ onMessageNew, enabled: true }));
    await flushConnect();

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

  it('handles data as object (not double-encoded string)', async () => {
    const onMessageNew = vi.fn();
    renderHook(() =>
      useWebSocket({ onMessageNew, enabled: true }),
    );
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    // When data is falsy/missing, falls back to msg itself
    ws.simulateMessage(JSON.stringify({
      type: 'message.new',
    }));

    expect(onMessageNew).toHaveBeenCalledWith({ type: 'message.new' });
  });

  it('keeps reconnecting after every close on the jittered backoff', async () => {
    renderHook(() =>
      useWebSocket({ enabled: true }),
    );
    await flushConnect();

    expect(MockWebSocket.instances).toHaveLength(1);

    // Delays are RANDOM inside a growing jitter envelope capped at 30s —
    // there is no fixed ladder to step through anymore. Advancing 31s is
    // guaranteed to fire whichever delay the curve drew, so we assert the
    // reconnect KEEPS HAPPENING (with a fresh ticket mint each time), never
    // an exact delay.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      MockWebSocket.instances[attempt - 1].simulateClose();
      expect(MockWebSocket.instances).toHaveLength(attempt);

      await act(async () => {
        vi.advanceTimersByTime(31_000);
        await Promise.resolve();
      });
      await flushConnect();
      expect(MockWebSocket.instances).toHaveLength(attempt + 1);
      expect(apiFetchMock).toHaveBeenCalledTimes(attempt + 1);
    }
  });

  it('aborts a reconnect when the ticket mint comes back empty', async () => {
    // On every (re)connect the hook mints a one-time upgrade ticket first.
    // If the mint resolves without a ticket (unexpected server response),
    // the connect attempt must bail out silently — no new socket and no
    // reschedule (a terminal auth rejection is handled by apiFetch's global
    // logout, which flips `enabled` and tears the hook down).
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();

    expect(MockWebSocket.instances).toHaveLength(1);
    apiFetchMock.mockResolvedValue({});
    MockWebSocket.instances[0].simulateClose();

    await act(async () => {
      vi.advanceTimersByTime(31_000); // fire the pending reconnect timer
      await Promise.resolve();
    });
    await flushConnect();

    // apiFetch resolved without a ticket → the connect attempt bailed at the
    // `if (!ticket) return` guard, so no new socket was ever created.
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances).toHaveLength(1);

    // …and nothing was rescheduled: another full backoff window passes
    // without a further mint attempt.
    await act(async () => {
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('schedules a backoff retry when the ticket mint fails at the network level', async () => {
    // A network-level mint failure (offline, server restarting) must book a
    // backoff retry — the old flow silently stalled with a dead socket.
    apiFetchMock.mockRejectedValue(new Error('network'));
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();

    // The initial mint failed → no socket, but a retry is pending.
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances).toHaveLength(0);

    // Once the network is back, the next retry opens a socket again.
    apiFetchMock.mockResolvedValue({ ticket: 'test-ticket' });
    await act(async () => {
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('resets the backoff curve after a successful open', async () => {
    renderHook(() =>
      useWebSocket({ enabled: true }),
    );
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateClose();
    await act(async () => {
      vi.advanceTimersByTime(31_000); // reconnect
      await Promise.resolve();
    });
    await flushConnect();

    const ws2 = MockWebSocket.instances[1];
    ws2.simulateOpen(); // healthy again — restarts the backoff curve
    ws2.simulateClose();

    // The reset is observable only as "still reconnects": delays are
    // jittered, so we assert the retry fires within the 30s cap rather
    // than at an exact first-step delay.
    await act(async () => {
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('calls onMembersChanged when receiving a members.changed event', async () => {
    const onMembersChanged = vi.fn();
    renderHook(() =>
      useWebSocket({ onMembersChanged, enabled: true }),
    );
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'members.changed',
      data: JSON.stringify({ channelID: 'ch-1' }),
    }));

    expect(onMembersChanged).toHaveBeenCalledWith({ channelID: 'ch-1' });
  });

  it('calls onConversationNew when receiving a conversation.new event', async () => {
    const onConversationNew = vi.fn();
    renderHook(() =>
      useWebSocket({ onConversationNew, enabled: true }),
    );
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'conversation.new',
      data: JSON.stringify({ conversationID: 'conv-1' }),
    }));

    expect(onConversationNew).toHaveBeenCalledWith({ conversationID: 'conv-1' });
  });

  it('calls onChannelArchived when receiving a channel.archived event', async () => {
    const onChannelArchived = vi.fn();
    renderHook(() =>
      useWebSocket({ onChannelArchived, enabled: true }),
    );
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'channel.archived',
      data: JSON.stringify({ channelID: 'ch-2' }),
    }));

    expect(onChannelArchived).toHaveBeenCalledWith({ channelID: 'ch-2' });
  });

  it('cleans up on unmount', async () => {
    const { unmount } = renderHook(() =>
      useWebSocket({ enabled: true }),
    );
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    unmount();

    expect(ws.closeCalled).toBe(true);
  });

  // Reconnect cursor: the last event ID seen on the live socket
  // must be sent as `since=…` on the next reconnect so the server
  // can replay anything missed during the disconnect.
  it('sends the last event id as ?since on reconnect', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      id: '01ID0000000000000000000099',
      type: 'message.new',
      data: JSON.stringify({ id: 'm1' }),
    }));
    ws.simulateClose();

    await act(async () => {
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('since=01ID0000000000000000000099');
  });

  // Cursor must be monotonic: an out-of-order live frame with a SMALLER ULID
  // (e.g. raced in from another instance) must not move the cursor backwards,
  // or the next reconnect would replay the in-between window and re-deliver.
  it('does not regress the reconnect cursor on an out-of-order frame', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();

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
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('since=01ID0000000000000000000099');
    expect(MockWebSocket.instances[1].url).not.toContain('since=01ID0000000000000000000042');
  });

  // An EPHEMERAL frame (presence/typing/notification.new) is never replayed, so
  // it must not advance the cursor — even with a higher ULID than a durable
  // message — or a reconnect would skip replaying messages between them.
  it('does not advance the reconnect cursor for an ephemeral frame', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();

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
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();

    expect(MockWebSocket.instances[1].url).toContain('since=01ID0000000000000000000099');
    expect(MockWebSocket.instances[1].url).not.toContain('since=01ID0000000000000000000150');
  });

  // First connect (no prior cursor) must not send a since param —
  // the server interprets that as "fresh, no replay needed".
  it('omits ?since on a fresh first connect', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();
    expect(MockWebSocket.instances[0].url).not.toContain('since=');
  });

  // Replay + live race: when an event ID arrives twice (once from
  // the durable replay, once from the live pubsub), the callback
  // must fire exactly once. Without dedup the cache would double-
  // apply mutations on every reconnect.
  it('deduplicates events by id across replay + live', async () => {
    const onMessageNew = vi.fn();
    renderHook(() => useWebSocket({ onMessageNew, enabled: true }));
    await flushConnect();

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
    await flushConnect();

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
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();

    expect(onReplayExhausted).toHaveBeenCalledTimes(1);
    // After exhausted the cursor is cleared — the reconnect must
    // not carry a stale since= that we already know is hopeless.
    expect(MockWebSocket.instances[1].url).not.toContain('since=');
  });

  // replay.done is a marker frame — no callback should fire for it,
  // and (importantly) it should NOT advance the cursor past the
  // last real event, otherwise the next reconnect would miss
  // anything published right after the marker.
  it('ignores replay.done as a no-op marker', async () => {
    const onMessageNew = vi.fn();
    renderHook(() => useWebSocket({ onMessageNew, enabled: true }));
    await flushConnect();

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
  it('closes the socket when the underlying connection errors', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    (ws.onerror as (e: unknown) => void)({});

    expect(ws.closeCalled).toBe(true);
  });

  // Full lifecycle in one flow: connect → durable event advances the replay
  // cursor → the socket drops repeatedly and each drop books a jittered retry
  // (fired with a 31s sweep — delays are random within the envelope, never
  // exact) with the cursor preserved on every reconnect URL → a successful
  // open resets the backoff curve, observable as the next drop still
  // reconnecting within the 30s cap.
  it('runs a full connect → backoff → reconnect → reset lifecycle preserving the replay cursor', async () => {
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();

    // Step 1: initial connect + a durable message.new advances lastEventId.
    const ws0 = MockWebSocket.instances[0];
    ws0.simulateOpen();
    ws0.simulateMessage(JSON.stringify({
      id: '01ID0000000000000000000100',
      type: 'message.new',
      data: JSON.stringify({ id: 'm1' }),
    }));

    // Step 2: the socket keeps dropping without ever re-opening → each close
    // books the next jittered retry.
    for (let i = 0; i < 4; i += 1) {
      MockWebSocket.instances[i].simulateClose();
      expect(MockWebSocket.instances).toHaveLength(i + 1);

      // A 31s sweep fires whatever delay the jitter drew (cap is 30s).
      await act(async () => {
        vi.advanceTimersByTime(31_000);
        await Promise.resolve();
      });
      await flushConnect();
      expect(MockWebSocket.instances).toHaveLength(i + 2);

      // Every reconnect carries the preserved cursor so the server can replay.
      expect(MockWebSocket.instances[i + 1].url).toContain('since=01ID0000000000000000000100');
    }

    // Step 3: the latest socket opens successfully → the backoff curve resets.
    const reconnected = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    reconnected.simulateOpen();

    // Step 4: it drops again → the reset is observable only as "still
    // reconnects within the cap" (exact delays are unobservable under jitter).
    const beforeReset = MockWebSocket.instances.length;
    reconnected.simulateClose();
    await act(async () => {
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await flushConnect();
    expect(MockWebSocket.instances).toHaveLength(beforeReset + 1);
    // The cursor is still preserved after the reset-and-reconnect.
    expect(MockWebSocket.instances[beforeReset].url).toContain('since=01ID0000000000000000000100');
  });
});
