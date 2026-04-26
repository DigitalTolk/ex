import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

vi.mock('@/lib/api', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
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

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useWebSocket - extra coverage', () => {
  it('calls onChannelUpdated for channel.updated events', () => {
    const onChannelUpdated = vi.fn();
    renderHook(() => useWebSocket({ onChannelUpdated, enabled: true }));

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'channel.updated',
      data: JSON.stringify({ channelID: 'ch-7' }),
    }));

    expect(onChannelUpdated).toHaveBeenCalledWith({ channelID: 'ch-7' });
  });

  it('calls onChannelNew for channel.new events', () => {
    const onChannelNew = vi.fn();
    renderHook(() => useWebSocket({ onChannelNew, enabled: true }));

    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(JSON.stringify({
      type: 'channel.new',
      data: JSON.stringify({ channelID: 'ch-new' }),
    }));

    expect(onChannelNew).toHaveBeenCalledWith({ channelID: 'ch-new' });
  });

  it('calls onChannelRemoved for channel.removed events', () => {
    const onChannelRemoved = vi.fn();
    renderHook(() => useWebSocket({ onChannelRemoved, enabled: true }));

    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(JSON.stringify({
      type: 'channel.removed',
      data: JSON.stringify({ channelID: 'ch-rm' }),
    }));

    expect(onChannelRemoved).toHaveBeenCalledWith({ channelID: 'ch-rm' });
  });

  it('calls ws.close() on error event', () => {
    renderHook(() => useWebSocket({ enabled: true }));

    const ws = MockWebSocket.instances[0];
    ws.simulateError();

    expect(ws.closeCalled).toBe(true);
  });

  it('ignores malformed JSON in messages', () => {
    const onMessageNew = vi.fn();
    renderHook(() => useWebSocket({ onMessageNew, enabled: true }));

    const ws = MockWebSocket.instances[0];
    // Should not throw
    expect(() => ws.simulateMessage('not-json{')).not.toThrow();
    expect(onMessageNew).not.toHaveBeenCalled();
  });

  it('does not reconnect on close when component disabled before close fires', () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useWebSocket({ enabled }),
      { initialProps: { enabled: true } },
    );

    expect(MockWebSocket.instances).toHaveLength(1);

    // Disable, then close
    rerender({ enabled: false });
    // After disabling, the cleanup will close the socket. We then simulate
    // a stray close on the (now disposed) instance:
    MockWebSocket.instances[0].simulateClose();

    vi.advanceTimersByTime(60_000);
    // No reconnect should have been scheduled
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not connect when there is no token', async () => {
    const mod = await import('@/lib/api');
    const getTokenMock = vi.mocked(mod.getAccessToken);
    getTokenMock.mockReturnValueOnce(null as unknown as string);

    renderHook(() => useWebSocket({ enabled: true }));

    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
