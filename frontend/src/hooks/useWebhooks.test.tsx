import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDeleteIncomingWebhook, useIncomingWebhooks } from './useWebhooks';
import { queryKeys } from '@/lib/query-keys';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

// The delete is optimistic: it drops the row from the list cache immediately so
// a delete never looks like a no-op on a slow connection, rolling back on error.
describe('useDeleteIncomingWebhook — optimistic removal', () => {
  it('removes the deleted row from the cache immediately and leaves the others intact', async () => {
    const qc = newClient();
    qc.setQueryData(queryKeys.incomingWebhooks(), [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]);
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDeleteIncomingWebhook(), { wrapper: makeWrapper(qc) });
    act(() => {
      result.current.mutate('a');
    });
    await waitFor(() => {
      // 'a' filtered out (predicate false), 'b' kept (predicate true).
      expect(qc.getQueryData(queryKeys.incomingWebhooks())).toEqual([{ id: 'b', title: 'B' }]);
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/webhooks/a', { method: 'DELETE' });
  });

  it('rolls the row back into the cache when the DELETE fails', async () => {
    const qc = newClient();
    qc.setQueryData(queryKeys.incomingWebhooks(), [{ id: 'a', title: 'A' }]);
    mockApiFetch.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useDeleteIncomingWebhook(), { wrapper: makeWrapper(qc) });
    act(() => {
      result.current.mutate('a');
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    // onError restored the pre-delete snapshot (context.previous truthy).
    expect(qc.getQueryData(queryKeys.incomingWebhooks())).toEqual([{ id: 'a', title: 'A' }]);
  });

  it('a failed delete with an unloaded cache does not throw and has nothing to roll back', async () => {
    const qc = newClient();
    // No list cached → onMutate sees `undefined` (the `rows ?? []` arm) and the
    // snapshot is undefined (the onError `context?.previous` falsy arm).
    mockApiFetch.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useDeleteIncomingWebhook(), { wrapper: makeWrapper(qc) });
    act(() => {
      result.current.mutate('missing');
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    // Optimistic write coerced the empty cache to [] and there was nothing to roll back.
    expect(qc.getQueryData(queryKeys.incomingWebhooks())).toEqual([]);
  });
});

describe('useIncomingWebhooks', () => {
  it('coerces a non-array response to an empty list (queryFn never returns undefined)', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const qc = newClient();
    const { result } = renderHook(() => useIncomingWebhooks(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});
