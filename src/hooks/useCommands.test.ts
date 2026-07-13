import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useCommands, useRunCommand } from './useCommands';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useCommands', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('returns the server command list', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      commands: [{ name: 'mstmeetings', description: 'Start a Teams meeting' }],
    });
    const { result } = renderHook(() => useCommands(), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ name: 'mstmeetings', description: 'Start a Teams meeting' }]);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/commands');
  });

  it('coerces a malformed response to an empty list', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ nope: true });
    const { result } = renderHook(() => useCommands(), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('does not fetch when disabled', async () => {
    const { result } = renderHook(() => useCommands(false), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('useRunCommand posts the invocation', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ message: { id: 'm1' } });
    const { result } = renderHook(() => useRunCommand(), { wrapper: wrapperFor(makeClient()) });
    const res = await result.current.mutateAsync({
      command: 'mstmeetings',
      parentType: 'channel',
      parentID: 'chan-1',
    });
    expect(res.message.id).toBe('m1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/commands/run', {
      method: 'POST',
      body: JSON.stringify({ command: 'mstmeetings', parentType: 'channel', parentID: 'chan-1' }),
    });
  });
});
