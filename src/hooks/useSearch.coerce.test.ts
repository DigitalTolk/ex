import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { useSearchUsers } from './useSearch';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

describe('useSearch queryFn coercion', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('coerces an empty search response to null (queryFn never resolves undefined)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const { result } = renderHook(() => useSearchUsers('alice', true), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});
