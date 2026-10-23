import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import {
  applyEmojiAddedEvent,
  applyEmojiRemovedEvent,
  invalidateEmojis,
  useEmojis,
  useEmojiMap,
  useFrequentEmojis,
  useUploadEmoji,
  useDeleteEmoji,
} from './useEmoji';
import { queryKeys } from '@/lib/query-keys';
import type { CustomEmoji } from '@/types';
import { EMOJI_FREQUENCY_CHANGED_EVENT } from '@/lib/emoji-frequency';
import { act } from '@testing-library/react';

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('useEmojis', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('fetches the list of custom emojis', async () => {
    vi.mocked(apiFetch).mockResolvedValue([
      { name: 'parrot', imageURL: 'https://cdn/parrot.gif', createdBy: 'u-1' },
    ]);
    const { result } = renderHook(() => useEmojis(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/emojis');
    expect(result.current.data).toHaveLength(1);
  });
});

describe('useFrequentEmojis', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('refetches the popular shelf when an emoji-use event fires', async () => {
    vi.mocked(apiFetch).mockResolvedValue([':tada:', ':smile:', ':wave:']);
    const { result } = renderHook(() => useFrequentEmojis(2), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current).toEqual([':tada:', ':smile:']));
    // The frequent shelf fetched exactly once (the hook also reads the shared
    // custom-emoji cache, so count only the frequent endpoint here).
    const frequentCalls = vi
      .mocked(apiFetch)
      .mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('/api/v1/emojis/frequent'));
    expect(frequentCalls).toHaveLength(1);

    vi.mocked(apiFetch).mockResolvedValue([':rocket:', ':fire:']);
    act(() => {
      window.dispatchEvent(new Event(EMOJI_FREQUENCY_CHANGED_EVENT));
    });
    await waitFor(() => expect(result.current).toEqual([':rocket:', ':fire:']));
  });

  it('returns the full shelf when no limit is given', async () => {
    vi.mocked(apiFetch).mockResolvedValue([':tada:', ':smile:', ':wave:']);
    const { result } = renderHook(() => useFrequentEmojis(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current).toEqual([':tada:', ':smile:', ':wave:']));
  });

  it('excludes "Getting Work Done" emojis from the quick-reaction list before the limit', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).startsWith('/api/v1/emojis/frequent')) {
        // :shipit: is the user's most-frequent, but it's a work-pack emoji.
        return [':shipit:', ':tada:', ':smile:', ':wave:'];
      }
      if (url === '/api/v1/emojis') {
        return [{ name: 'shipit', imageURL: 'x', createdBy: 'u', createdAt: '', gettingWorkDone: true }];
      }
      return [];
    });
    const { result } = renderHook(() => useFrequentEmojis(2), { wrapper: createWrapper() });
    // :shipit: is filtered out, so the top-2 are the next genuine reactions.
    await waitFor(() => expect(result.current).toEqual([':tada:', ':smile:']));
  });
});

describe('useEmojiMap', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('returns a name→imageURL map derived from the emoji list', async () => {
    vi.mocked(apiFetch).mockResolvedValue([
      { name: 'parrot', imageURL: 'https://cdn/parrot.gif', createdBy: 'u-1' },
      { name: 'cat', imageURL: 'https://cdn/cat.png', createdBy: 'u-2' },
    ]);
    const { result } = renderHook(() => useEmojiMap(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      parrot: 'https://cdn/parrot.gif',
      cat: 'https://cdn/cat.png',
    });
  });
});

describe('useEmojiMap re-renders', () => {
  it('derives the map once per list change, not on every consumer render', () => {
    // Every message row reads the map; an inline select re-built it from the
    // whole list on each render of each row.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let nameReads = 0;
    const emoji = (name: string, imageURL: string) => {
      const e = { imageURL, createdBy: 'u-1', createdAt: '2026-01-01T00:00:00Z' } as CustomEmoji;
      Object.defineProperty(e, 'name', {
        enumerable: true,
        get() {
          nameReads++;
          return name;
        },
      });
      return e;
    };
    qc.setQueryData(queryKeys.emojis(), [emoji('parrot', 'https://cdn/parrot.gif'), emoji('cat', 'https://cdn/cat.png')]);
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const { result, rerender } = renderHook(() => useEmojiMap(), { wrapper });
    const first = result.current.data;
    expect(first).toEqual({ parrot: 'https://cdn/parrot.gif', cat: 'https://cdn/cat.png' });

    nameReads = 0;
    for (let i = 0; i < 5; i++) rerender();
    expect(nameReads).toBe(0);
    expect(result.current.data).toBe(first);
  });
});

describe('emoji events', () => {
  const party: CustomEmoji = { name: 'party', imageURL: '/e/party.png', createdBy: 'u-1', createdAt: '2026-01-01T00:00:00Z' };
  const shipit: CustomEmoji = { name: 'shipit', imageURL: '/e/shipit.png', createdBy: 'u-2', createdAt: '2026-01-02T00:00:00Z' };

  it('patches an added emoji into the cached list without a refetch', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.emojis(), [party]);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    applyEmojiAddedEvent(qc, shipit);
    expect(qc.getQueryData(queryKeys.emojis())).toEqual([party, shipit]);
    // The uploader's own tab gets the echo too: re-adding replaces, never duplicates.
    applyEmojiAddedEvent(qc, { ...shipit, imageURL: '/e/shipit-2.png' });
    expect(qc.getQueryData(queryKeys.emojis())).toEqual([party, { ...shipit, imageURL: '/e/shipit-2.png' }]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('removes a deleted emoji and refreshes only the quick-reaction shelf', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.emojis(), [party, shipit]);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    applyEmojiRemovedEvent(qc, 'party');
    expect(qc.getQueryData(queryKeys.emojis())).toEqual([shipit]);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.frequentEmojis(), exact: true });
  });

  it('leaves a list that was never loaded alone', () => {
    const qc = new QueryClient();
    applyEmojiAddedEvent(qc, shipit);
    applyEmojiRemovedEvent(qc, 'party');
    expect(qc.getQueryData(queryKeys.emojis())).toBeUndefined();
  });

  // The fallback for an emoji event whose payload fails its schema.
  it('invalidateEmojis refetches the catalogue and leaves the cached list as it is', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.emojis(), [party]);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    invalidateEmojis(qc);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.emojis() });
    expect(qc.getQueryData(queryKeys.emojis())).toEqual([party]);
  });
});

describe('useUploadEmoji', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    // @ts-expect-error vitest can override fetch
    globalThis.fetch = vi.fn();
  });

  it('uploads file via signed URL and posts the new emoji record', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ uploadURL: 'https://upload.test/u', key: 'uploads/u-1/x.png' })
      .mockResolvedValueOnce({ name: 'new', imageURL: 'https://cdn/x.png', createdBy: 'u-1' });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true } as Response);

    const { result } = renderHook(() => useUploadEmoji(), { wrapper: createWrapper() });
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    await result.current.mutateAsync({ name: 'new', file, gettingWorkDone: true });

    // First call: get signed URL
    expect(apiFetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/uploads/url',
      expect.objectContaining({ method: 'POST' }),
    );
    // Second call: persist the emoji record
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/emojis',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(vi.mocked(apiFetch).mock.calls[1][1]?.body as string);
    expect(body).toEqual({ name: 'new', imageKey: 'uploads/u-1/x.png', gettingWorkDone: true });
    // PUT to the signed URL with the file
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://upload.test/u',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('throws when the PUT upload fails', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      uploadURL: 'https://upload.test/u',
      key: 'uploads/u-1/x.png',
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const { result } = renderHook(() => useUploadEmoji(), { wrapper: createWrapper() });
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    await expect(
      result.current.mutateAsync({ name: 'new', file, gettingWorkDone: false }),
    ).rejects.toThrow(/Upload failed: 500/);
  });
});

describe('useDeleteEmoji', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('DELETEs the named emoji with URL-encoded name', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({});
    const { result } = renderHook(() => useDeleteEmoji(), { wrapper: createWrapper() });
    await result.current.mutateAsync('party+parrot');
    expect(apiFetch).toHaveBeenCalledWith(
      `/api/v1/emojis/${encodeURIComponent('party+parrot')}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
