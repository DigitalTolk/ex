import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useUserConversations,
  useConversation,
  useSearchUsers,
  useAllUsers,
  useOpenDM,
} from './useConversations';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';

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

describe('single-object/array coercion to a non-undefined queryFn result', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('useConversation coerces an empty response to null', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const { result } = renderHook(() => useConversation('conv-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('useSearchUsers coerces a non-array response to []', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const { result } = renderHook(() => useSearchUsers('al'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('useAllUsers coerces a non-array response to []', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const { result } = renderHook(() => useAllUsers(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

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

// useOpenDM is the single shared "message this person" implementation
// (SearchBar person rows, search-results People tab, directory cards).
describe('useOpenDM', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    navigateMock.mockClear();
    vi.mocked(showToast).mockClear();
  });

  it('creates the DM, runs the caller onSuccess, then navigates', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: 'cv-9' });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useOpenDM(), { wrapper: createWrapper() });
    act(() => {
      result.current.openDM('u-1', { onSuccess });
    });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/conversation/cv-9'));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
      '/api/v1/conversations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ type: 'dm', participantIDs: ['u-1'] }),
      }),
    );
    expect(showToast).not.toHaveBeenCalled();
  });

  it('surfaces a failed create with a toast and neither navigates nor runs onSuccess', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('boom'));
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useOpenDM(), { wrapper: createWrapper() });
    act(() => {
      result.current.openDM('u-1', { onSuccess });
    });
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(navigateMock).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('navigates without a caller onSuccess (opts are optional)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: 'cv-10' });
    const { result } = renderHook(() => useOpenDM(), { wrapper: createWrapper() });
    act(() => {
      result.current.openDM('u-2');
    });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/conversation/cv-10'));
  });
});
