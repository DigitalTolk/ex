import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useUserConversations } from './useConversations';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

describe('useUserConversations', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('calls correct endpoint', async () => {
    const conversations = [
      {
        conversationID: 'conv-1',
        type: 'dm',
        displayName: 'Alice',
      },
    ];
    vi.mocked(apiFetch).mockResolvedValue(conversations);

    const { result } = renderHook(() => useUserConversations(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations');
    expect(result.current.data).toEqual(conversations);
  });
});
