import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

// Mock getAccessToken
vi.mock('@/lib/api', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
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

  it('reconnects with exponential backoff on close', () => {
    renderHook(() =>
      useWebSocket({ enabled: true }),
    );

    expect(MockWebSocket.instances).toHaveLength(1);

    // Simulate close
    MockWebSocket.instances[0].simulateClose();

    // Should not reconnect immediately
    expect(MockWebSocket.instances).toHaveLength(1);

    // Advance timer by 1000ms (first backoff)
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Close again
    MockWebSocket.instances[1].simulateClose();

    // Advance timer by 2000ms (second backoff)
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('resets retry count after successful open', () => {
    renderHook(() =>
      useWebSocket({ enabled: true }),
    );

    const ws = MockWebSocket.instances[0];
    ws.simulateClose();
    vi.advanceTimersByTime(1000); // reconnect

    const ws2 = MockWebSocket.instances[1];
    ws2.simulateOpen(); // resets retry count
    ws2.simulateClose();

    // Should use 1000ms backoff again (retry count was reset)
    vi.advanceTimersByTime(1000);
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
