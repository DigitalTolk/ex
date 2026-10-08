import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useUserState } from './useUserState';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useUserState threadMarkedUnread', () => {
  it('keeps the marked-unread map, and defaults it for older servers', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ threadSeen: { t: 'a' }, threadMarkedUnread: { t: 'b' } });
    const marked = renderHook(() => useUserState(), { wrapper });
    await waitFor(() => expect(marked.result.current.data?.threadMarkedUnread).toEqual({ t: 'b' }));

    vi.mocked(apiFetch).mockResolvedValueOnce({ threadSeen: {} });
    const legacy = renderHook(() => useUserState(), { wrapper });
    await waitFor(() => expect(legacy.result.current.isPlaceholderData).toBe(false));
    expect(legacy.result.current.data?.threadMarkedUnread).toEqual({});
  });
});
