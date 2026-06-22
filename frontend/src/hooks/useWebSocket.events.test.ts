import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';

vi.mock('@/lib/api', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
  refreshAccessToken: vi.fn(async () => 'test-token'),
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

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('useWebSocket event coverage', () => {
  it('routes draft.updated to onDraftUpdated', () => {
    const onDraftUpdated = vi.fn();
    renderHook(() => useWebSocket({ onDraftUpdated, enabled: true }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ id: 'd1', type: 'draft.updated', data: JSON.stringify({ draftID: 'x' }) }));
    expect(onDraftUpdated).toHaveBeenCalled();
  });

  it('routes notification.settings_updated to onNotificationSettingsUpdated', () => {
    const onNotificationSettingsUpdated = vi.fn();
    renderHook(() => useWebSocket({ onNotificationSettingsUpdated, enabled: true }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ id: 'ns1', type: 'notification.settings_updated', data: JSON.stringify({ settings: { desktopLevel: 'all' } }) }));
    expect(onNotificationSettingsUpdated).toHaveBeenCalled();
  });

  it('routes webhook.changed to onWebhookChanged', () => {
    const onWebhookChanged = vi.fn();
    renderHook(() => useWebSocket({ onWebhookChanged, enabled: true }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ id: 'w1', type: 'webhook.changed', data: '{}' }));
    expect(onWebhookChanged).toHaveBeenCalled();
  });

  it('evicts the oldest id once the dedup buffer exceeds capacity', () => {
    const onMessageNew = vi.fn();
    renderHook(() => useWebSocket({ onMessageNew, enabled: true }));
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

  it('does not dedup messages that arrive without an envelope id', () => {
    const onMessageNew = vi.fn();
    renderHook(() => useWebSocket({ onMessageNew, enabled: true }));
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    const msg = JSON.stringify({ type: 'message.new', data: JSON.stringify({ id: 'a' }) });
    ws.simulateMessage(msg);
    ws.simulateMessage(msg);
    // No id => markSeen returns false each time => delivered twice.
    expect(onMessageNew.mock.calls.length).toBe(2);
  });

  it('does not open a socket when no access token is available', async () => {
    const api = await import('@/lib/api');
    (api.getAccessToken as unknown as { mockReturnValueOnce: (v: string) => void }).mockReturnValueOnce('');
    renderHook(() => useWebSocket({ enabled: true }));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

});
