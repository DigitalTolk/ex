import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
  apiFetch: apiFetchMock,
}));

type WSHandler = ((ev: unknown) => void) | null;
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: WSHandler = null;
  onmessage: WSHandler = null;
  onclose: WSHandler = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send() {}
  close() {}
  simulateOpen() { this.onopen?.({} as unknown); }
  simulateMessage(data: string) { this.onmessage?.({ data } as unknown); }
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
});
afterEach(() => { vi.restoreAllMocks(); });

describe('useWebSocket event coverage', () => {
  it('routes draft.updated to onDraftUpdated', async () => {
    const onDraftUpdated = vi.fn();
    renderHook(() => useWebSocket({ onDraftUpdated, enabled: true }));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ id: 'd1', type: 'draft.updated', data: JSON.stringify({ draftID: 'x' }) }));
    expect(onDraftUpdated).toHaveBeenCalled();
  });

  it('routes notification.settings_updated to onNotificationSettingsUpdated', async () => {
    const onNotificationSettingsUpdated = vi.fn();
    renderHook(() => useWebSocket({ onNotificationSettingsUpdated, enabled: true }));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ id: 'ns1', type: 'notification.settings_updated', data: JSON.stringify({ settings: { desktopLevel: 'all' } }) }));
    expect(onNotificationSettingsUpdated).toHaveBeenCalled();
  });

  it('routes webhook.changed to onWebhookChanged', async () => {
    const onWebhookChanged = vi.fn();
    renderHook(() => useWebSocket({ onWebhookChanged, enabled: true }));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ id: 'w1', type: 'webhook.changed', data: '{}' }));
    expect(onWebhookChanged).toHaveBeenCalled();
  });

  it('routes activity.new to onActivityNew', async () => {
    const onActivityNew = vi.fn();
    renderHook(() => useWebSocket({ onActivityNew, enabled: true }));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ id: 'act1', type: 'activity.new', data: '{}' }));
    expect(onActivityNew).toHaveBeenCalled();
  });

  it('routes thread.updated to onThreadUpdated', async () => {
    const onThreadUpdated = vi.fn();
    renderHook(() => useWebSocket({ onThreadUpdated, enabled: true }));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ id: 'th1', type: 'thread.updated', data: '{"threadRootID":"root-1"}' }));
    expect(onThreadUpdated).toHaveBeenCalledWith(expect.objectContaining({ threadRootID: 'root-1' }));
  });

  it('evicts the oldest id once the dedup buffer exceeds capacity', async () => {
    const onMessageNew = vi.fn();
    renderHook(() => useWebSocket({ onMessageNew, enabled: true }));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    for (let i = 1; i <= 513; i++) {
      ws.simulateMessage(JSON.stringify({ id: String(i), type: 'message.new', data: JSON.stringify({ id: String(i) }) }));
    }
    const before = onMessageNew.mock.calls.length;
    // id "1" was evicted (capacity 512), so re-delivery fires again.
    ws.simulateMessage(JSON.stringify({ id: '1', type: 'message.new', data: JSON.stringify({ id: '1' }) }));
    expect(onMessageNew.mock.calls.length).toBe(before + 1);
  });

  it('does not dedup messages that arrive without an envelope id', async () => {
    const onMessageNew = vi.fn();
    renderHook(() => useWebSocket({ onMessageNew, enabled: true }));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    const msg = JSON.stringify({ type: 'message.new', data: JSON.stringify({ id: 'a' }) });
    ws.simulateMessage(msg);
    ws.simulateMessage(msg);
    // No id => never recorded as seen => delivered twice.
    expect(onMessageNew.mock.calls.length).toBe(2);
  });

  it('does not open a socket when no access token is available', async () => {
    const api = await import('@/lib/api');
    (api.getAccessToken as unknown as { mockReturnValueOnce: (v: string) => void }).mockReturnValueOnce('');
    renderHook(() => useWebSocket({ enabled: true }));
    await flushConnect();
    // No token → connect bails before even minting a ticket.
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

});
