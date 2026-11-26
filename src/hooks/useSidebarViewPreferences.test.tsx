import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { queryKeys } from '@/lib/query-keys';
import { useSidebarViewPreferences } from './useSidebarViewPreferences';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

const state = (sidebarSorts: Record<string, 'recent' | 'az'>) => ({
  threadNotifications: [],
  threadSeen: {},
  threadMarkedUnread: {},
  hiddenConversations: [],
  hiddenSkills: [],
  sidebarSorts,
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, ...renderHook(() => useSidebarViewPreferences(), { wrapper }) };
}

describe('useSidebarViewPreferences: section sorts', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    localStorage.clear();
  });

  it("shows a sort just chosen while it saves, then the server's", async () => {
    let release: () => void = () => {};
    mockApiFetch.mockImplementation((url: string) =>
      url === '/api/v1/user-state' ? Promise.resolve(state({})) : new Promise<void>((resolve) => (release = resolve)),
    );
    const { qc, result } = setup();
    await waitFor(() => expect(qc.getQueryState(queryKeys.userState())?.status).toBe('success'));
    expect(result.current.sectionSort('__channels__')).toBe('az');

    act(() => result.current.setSectionSort('__channels__', 'recent'));
    expect(result.current.sectionSort('__channels__')).toBe('recent');
    expect(result.current.sectionSorts).toEqual({ __channels__: 'recent' });

    // Saved: it is the server's now, and another device's later choice
    // (arriving as a user-state update) shows.
    await act(async () => release());
    act(() => qc.setQueryData(queryKeys.userState(), state({ __channels__: 'az' })));
    await waitFor(() => expect(result.current.sectionSort('__channels__')).toBe('az'));
  });

  it('drops a sort whose save failed', async () => {
    mockApiFetch.mockImplementation((url: string) =>
      url === '/api/v1/user-state' ? Promise.resolve(state({})) : Promise.reject(new Error('offline')),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.sectionSort('__favorites__')).toBe('az'));

    act(() => result.current.setSectionSort('__favorites__', 'recent'));
    expect(result.current.sectionSort('__favorites__')).toBe('recent');
    await waitFor(() => expect(result.current.sectionSort('__favorites__')).toBe('az'));
  });

  it('keeps Direct Messages out of the per-section sorts', async () => {
    mockApiFetch.mockImplementation(() => Promise.resolve(state({ __dms__: 'az', __unread__: 'recent' })));
    const { result } = setup();
    await waitFor(() => expect(result.current.conversationSort).toBe('az'));
    expect(result.current.sectionSorts).toEqual({ __unread__: 'recent' });
    expect(result.current.sectionSort('__dms__')).toBe('az');
  });

  it("opens with this device's copy until the user state arrives, then keeps the copy in step", async () => {
    localStorage.setItem('sidebar.sectionSorts', JSON.stringify({ __channels__: 'recent' }));
    let arrive: (value: unknown) => void = () => {};
    mockApiFetch.mockImplementation(() => new Promise((resolve) => (arrive = resolve)));
    const { result } = setup();
    expect(result.current.sectionSort('__channels__')).toBe('recent');

    act(() => arrive(state({ __favorites__: 'recent' })));
    await waitFor(() => expect(result.current.sectionSort('__favorites__')).toBe('recent'));
    expect(result.current.sectionSort('__channels__')).toBe('az');
    expect(JSON.parse(localStorage.getItem('sidebar.sectionSorts')!)).toEqual({ __favorites__: 'recent' });
  });

  it.each(['{not json', '[]', 'null', '{"__channels__":"newest","__unread__":"recent"}'])(
    'reads a device copy of %s safely',
    (raw) => {
      localStorage.setItem('sidebar.sectionSorts', raw);
      mockApiFetch.mockImplementation(() => new Promise(() => {}));
      const { result } = setup();
      expect(result.current.sectionSorts).toEqual(raw.includes('__unread__') ? { __unread__: 'recent' } : {});
    },
  );

  it('keeps a saved sort without fetching the user state again', async () => {
    mockApiFetch.mockImplementation((url: string) => Promise.resolve(url === '/api/v1/user-state' ? state({}) : undefined));
    const { qc, result } = setup();
    await waitFor(() => expect(qc.getQueryState(queryKeys.userState())?.status).toBe('success'));

    act(() => result.current.setSectionSort('__unread__', 'recent'));
    await waitFor(() =>
      expect(qc.getQueryData<{ sidebarSorts: Record<string, string> }>(queryKeys.userState())?.sidebarSorts).toEqual({
        __unread__: 'recent',
      }),
    );
    expect(result.current.sectionSort('__unread__')).toBe('recent');
    expect(JSON.parse(localStorage.getItem('sidebar.sectionSorts')!)).toEqual({ __unread__: 'recent' });
    // One load at start, one save: the save's echo doesn't refetch.
    expect(mockApiFetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/user-state',
      '/api/v1/user-state/sidebar-sorts/__unread__',
    ]);
  });

  it('saves into the device copy while the user state is still loading', async () => {
    mockApiFetch.mockImplementation((url: string) => (url === '/api/v1/user-state' ? new Promise(() => {}) : Promise.resolve()));
    const { result } = setup();
    act(() => result.current.setSectionSort('cat-1', 'recent'));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('sidebar.sectionSorts') ?? '{}')).toEqual({ 'cat-1': 'recent' }));
    expect(result.current.sectionSort('cat-1')).toBe('recent');
  });

  it('keeps the latest choice when an earlier save for the section lands after it', async () => {
    const saves: Array<() => void> = [];
    mockApiFetch.mockImplementation((url: string) =>
      url === '/api/v1/user-state' ? Promise.resolve(state({})) : new Promise<void>((resolve) => saves.push(resolve)),
    );
    const { qc, result } = setup();
    await waitFor(() => expect(qc.getQueryState(queryKeys.userState())?.status).toBe('success'));

    act(() => result.current.setSectionSort('__favorites__', 'recent'));
    act(() => result.current.setSectionSort('__favorites__', 'az'));
    expect(result.current.sectionSort('__favorites__')).toBe('az');
    // The first save ("recent") lands after the second was sent: it changes
    // nothing here, and A-Z stands until its own save lands.
    await act(async () => saves[0]());
    expect(result.current.sectionSort('__favorites__')).toBe('az');
    await act(async () => saves[1]());
    expect(result.current.sectionSort('__favorites__')).toBe('az');
    expect(qc.getQueryData<{ sidebarSorts: Record<string, string> }>(queryKeys.userState())?.sidebarSorts).toEqual({
      __favorites__: 'az',
    });
  });

  it('ignores an earlier save that fails after a later one was sent', async () => {
    const saves: Array<{ ok: () => void; fail: () => void }> = [];
    mockApiFetch.mockImplementation((url: string) =>
      url === '/api/v1/user-state'
        ? Promise.resolve(state({}))
        : new Promise<void>((resolve, reject) => saves.push({ ok: resolve, fail: () => reject(new Error('offline')) })),
    );
    const { qc, result } = setup();
    await waitFor(() => expect(qc.getQueryState(queryKeys.userState())?.status).toBe('success'));
    act(() => result.current.setSectionSort('__favorites__', 'recent'));
    act(() => result.current.setSectionSort('__favorites__', 'az'));
    await act(async () => saves[0].fail());
    expect(result.current.sectionSort('__favorites__')).toBe('az');
    await act(async () => saves[1].ok());
    expect(result.current.sectionSort('__favorites__')).toBe('az');
  });

  it('reads a user state without sidebar sorts (an older server) as none saved', async () => {
    mockApiFetch.mockImplementation(() => Promise.resolve(state({ __unread__: 'recent' })));
    const { qc, result } = setup();
    await waitFor(() => expect(result.current.sectionSort('__unread__')).toBe('recent'));
    const older: Record<string, unknown> = state({});
    delete older.sidebarSorts;
    act(() => qc.setQueryData(queryKeys.userState(), older));
    await waitFor(() => expect(result.current.sectionSorts).toEqual({}));
  });

  it('saves into the device copy when the user state is gone by the time the save lands', async () => {
    let land: () => void = () => {};
    mockApiFetch.mockImplementation((url: string) =>
      url === '/api/v1/user-state' ? Promise.resolve(state({})) : new Promise<void>((resolve) => (land = resolve)),
    );
    const { qc, result } = setup();
    await waitFor(() => expect(qc.getQueryState(queryKeys.userState())?.status).toBe('success'));

    act(() => result.current.setSectionSort('__channels__', 'recent'));
    // Signed out meanwhile: the cached user state is dropped.
    qc.removeQueries({ queryKey: queryKeys.userState() });
    await act(async () => land());
    expect(JSON.parse(localStorage.getItem('sidebar.sectionSorts')!)).toEqual({ __channels__: 'recent' });
  });
});
