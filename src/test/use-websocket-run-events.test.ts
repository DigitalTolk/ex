import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from '@/hooks/useWebSocket';

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

describe('useWebSocket agent-run events', () => {
  it('routes run.updated to onRunUpdated', async () => {
    const onRunUpdated = vi.fn();
    renderHook(() => useWebSocket({ onRunUpdated, enabled: true }));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(
      JSON.stringify({ id: 'ru1', type: 'run.updated', data: '{"id":"r1","state":"running"}' }),
    );
    expect(onRunUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1', state: 'running' }),
    );
  });

  it('routes run.progress to onRunProgress', async () => {
    const onRunProgress = vi.fn();
    renderHook(() => useWebSocket({ onRunProgress, enabled: true }));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(
      JSON.stringify({ id: 'rp1', type: 'run.progress', data: '{"runID":"r1","kind":"tool"}' }),
    );
    expect(onRunProgress).toHaveBeenCalledWith(
      expect.objectContaining({ runID: 'r1', kind: 'tool' }),
    );
  });

  it('routes run.approval to onRunApproval', async () => {
    const onRunApproval = vi.fn();
    renderHook(() => useWebSocket({ onRunApproval, enabled: true }));
    await flushConnect();
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(
      JSON.stringify({ id: 'ra1', type: 'run.approval', data: '{"approvalID":"ap-1"}' }),
    );
    expect(onRunApproval).toHaveBeenCalledWith(expect.objectContaining({ approvalID: 'ap-1' }));
  });
});
