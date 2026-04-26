import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { useEmojis, useEmojiMap, useUploadEmoji, useDeleteEmoji } from './useEmoji';

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

describe('useUploadEmoji', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    // @ts-expect-error vitest can override fetch
    globalThis.fetch = vi.fn();
  });

  it('uploads file via signed URL and posts the new emoji record', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ uploadURL: 'https://upload.test/u', fileURL: 'https://cdn/x.png' })
      .mockResolvedValueOnce({ name: 'new', imageURL: 'https://cdn/x.png', createdBy: 'u-1' });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true } as Response);

    const { result } = renderHook(() => useUploadEmoji(), { wrapper: createWrapper() });
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    await result.current.mutateAsync({ name: 'new', file });

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
    // PUT to the signed URL with the file
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://upload.test/u',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('throws when the PUT upload fails', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      uploadURL: 'https://upload.test/u',
      fileURL: 'https://cdn/x.png',
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const { result } = renderHook(() => useUploadEmoji(), { wrapper: createWrapper() });
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    await expect(
      result.current.mutateAsync({ name: 'new', file }),
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
