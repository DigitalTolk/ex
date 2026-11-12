import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  applySharePointChangedEvent,
  SharePointHostsContext,
  useRetrySharePointLink,
  useSharePointHosts,
  useSharePointHostsSetting,
  useSharePointLink,
  useSharePointPreview,
} from './useSharePoint';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

const LINK = 'https://contoso.sharepoint.com/:w:/s/team/Eabc?e=1';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}

beforeEach(() => apiFetchMock.mockReset());

describe('useSharePointHosts', () => {
  it('reads the hosts the app root provides, none outside it', () => {
    const { wrapper } = setup();
    expect(renderHook(() => useSharePointHosts(), { wrapper }).result.current).toEqual([]);
    const withHosts = ({ children }: { children: ReactNode }) =>
      wrapper({ children: <SharePointHostsContext.Provider value={['*.sharepoint.com']}>{children}</SharePointHostsContext.Provider> });
    expect(renderHook(() => useSharePointHosts(), { wrapper: withHosts }).result.current).toEqual(['*.sharepoint.com']);
  });
});

describe('useSharePointHostsSetting', () => {
  it('reads the hosts from the workspace settings once signed in', async () => {
    apiFetchMock.mockResolvedValue({ maxUploadBytes: 0, allowedExtensions: [], sharePointHosts: ['*.sharepoint.com'] });
    const { wrapper } = setup();
    const signedOut = renderHook(() => useSharePointHostsSetting(false), { wrapper });
    expect(signedOut.result.current).toEqual([]);
    expect(apiFetchMock).not.toHaveBeenCalled();
    const signedIn = renderHook(() => useSharePointHostsSetting(true), { wrapper });
    await waitFor(() => expect(signedIn.result.current).toEqual(['*.sharepoint.com']));
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/admin/settings');
  });
});

describe('useSharePointLink', () => {
  it('asks about the link in its channel', async () => {
    apiFetchMock.mockResolvedValueOnce({ url: LINK, status: 'shared', posterID: 'u-1' });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSharePointLink({ channelId: 'ch-1' }, LINK), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe('shared'));
    const target = new URL(apiFetchMock.mock.calls[0][0] as string, 'http://x');
    expect(target.pathname).toBe('/api/v1/sharepoint/link');
    expect(Object.fromEntries(target.searchParams)).toEqual({ parentType: 'channel', parentID: 'ch-1', url: LINK });
  });

  it('is null for a link that was never shared', async () => {
    apiFetchMock.mockResolvedValueOnce(undefined); // 204
    const { wrapper } = setup();
    const { result } = renderHook(() => useSharePointLink({ conversationId: 'dm-1' }, LINK), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(apiFetchMock.mock.calls[0][0]).toContain('parentType=conversation&parentID=dm-1');
  });

  it('waits for a parent', () => {
    const { wrapper } = setup();
    renderHook(() => useSharePointLink({}, LINK), { wrapper });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('useSharePointPreview', () => {
  it('reads the address that shows the file, once, and never keeps it', async () => {
    apiFetchMock.mockResolvedValueOnce({ url: 'https://contoso.sharepoint.com/embed?nb=true' });
    const { qc, wrapper } = setup();
    const { result, unmount } = renderHook(() => useSharePointPreview({ conversationId: 'dm-1' }, 'f-1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBe('https://contoso.sharepoint.com/embed?nb=true'));
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/sharepoint/preview?parentType=conversation&parentID=dm-1&fileID=f-1');
    // Never stale while it shows (a window focus doesn't reload the viewer),
    // and gone once the lightbox closes: the address expires.
    expect(result.current.isStale).toBe(false);
    unmount();
    await waitFor(() => expect(qc.getQueryCache().findAll({ queryKey: ['sharepoint-preview'] })).toHaveLength(0));
  });
});

describe('useRetrySharePointLink', () => {
  it('retries as the poster and refetches the card', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { qc, wrapper } = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRetrySharePointLink({ conversationId: 'dm-1' }, LINK), { wrapper });
    await act(() => result.current.mutateAsync());
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/sharepoint/link/retry', {
      method: 'POST',
      body: JSON.stringify({ parentType: 'conversation', parentID: 'dm-1', url: LINK }),
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['sharepoint', 'conversations/dm-1', LINK] });
  });

  it('names the channel when retrying there', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { wrapper } = setup();
    const { result } = renderHook(() => useRetrySharePointLink({ channelId: 'ch-1' }, LINK), { wrapper });
    await act(() => result.current.mutateAsync());
    expect(JSON.parse(apiFetchMock.mock.calls[0][1].body)).toEqual({ parentType: 'channel', parentID: 'ch-1', url: LINK });
  });
});

describe('applySharePointChangedEvent', () => {
  it('refetches the links that changed and the Files panel', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applySharePointChangedEvent(qc, { parentID: 'ch-1', parentType: 'channel', urls: [LINK] });
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([
      ['sharepoint', 'channels/ch-1', LINK],
      ['files', 'channels/ch-1'],
    ]);
  });

  it('refetches every link in the parent for an empty list', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applySharePointChangedEvent(qc, { parentID: 'dm-1', parentType: 'conversation', urls: [] });
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([
      ['sharepoint', 'conversations/dm-1'],
      ['files', 'conversations/dm-1'],
    ]);
  });
});
