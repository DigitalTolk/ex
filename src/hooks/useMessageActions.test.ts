import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import { useInvokeMessageAction } from './useMessageActions';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

describe('useInvokeMessageAction', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue({});
  });

  it('targets the channel route and defaults the selection to empty', async () => {
    const { result } = renderHook(() => useInvokeMessageAction(), { wrapper });
    result.current.mutate({ parentType: 'channel', parentID: 'ch 1', messageID: 'm1', actionID: 'act1' });

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    // Ids are URL-encoded so an id with a reserved character can't alter the path.
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch%201/messages/m1/actions/act1', {
      method: 'POST',
      body: JSON.stringify({ selected_option: '' }),
    });
  });

  it('targets the conversation route and forwards the chosen option', async () => {
    const { result } = renderHook(() => useInvokeMessageAction(), { wrapper });
    result.current.mutate({
      parentType: 'conversation',
      parentID: 'conv1',
      messageID: 'm2',
      actionID: 'sel1',
      selectedOption: 'prod',
    });

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/conv1/messages/m2/actions/sel1', {
      method: 'POST',
      body: JSON.stringify({ selected_option: 'prod' }),
    });
  });
});
