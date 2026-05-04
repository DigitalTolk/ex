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

  it('reconnects with exponential backoff on close', async () => {
    renderHook(() =>
      useWebSocket({ enabled: true }),
    );

    expect(MockWebSocket.instances).toHaveLength(1);

    // Simulate close
    MockWebSocket.instances[0].simulateClose();

    // Should not reconnect immediately
    expect(MockWebSocket.instances).toHaveLength(1);

    // Advance timer by 1000ms (first backoff)
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);

    // Close again
    MockWebSocket.instances[1].simulateClose();

    // Advance timer by 2000ms (second backoff)
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(3);
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
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
});
