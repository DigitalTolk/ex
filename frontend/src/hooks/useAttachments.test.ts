import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import {
  uploadAttachment,
  useAttachment,
  useAttachmentsBatch,
  useDeleteDraftAttachment,
} from './useAttachments';

function createWrapper(qc?: QueryClient) {
  const client = qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc: client,
    Wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  };
}

// Minimal XMLHttpRequest stub. Tests trigger the lifecycle hooks manually.
class XHRMock {
  static last: XHRMock | null = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  openedWith: { method: string; url: string } | null = null;
  headers: Record<string, string> = {};
  sentBody: unknown = null;
  open(method: string, url: string) {
    this.openedWith = { method, url };
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.sentBody = body;
    XHRMock.last = this;
  }
}

describe('uploadAttachment', () => {
  let originalXHR: typeof XMLHttpRequest;
  let originalSubtle: SubtleCrypto | undefined;

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    originalXHR = globalThis.XMLHttpRequest;
    // @ts-expect-error overriding XHR for tests
    globalThis.XMLHttpRequest = XHRMock;
    XHRMock.last = null;
    // jsdom may not have crypto.subtle — stub it deterministically.
    originalSubtle = globalThis.crypto.subtle;
    Object.defineProperty(globalThis.crypto, 'subtle', {
      value: {
        digest: vi.fn().mockResolvedValue(new Uint8Array([0xab, 0xcd]).buffer),
      },
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.XMLHttpRequest = originalXHR;
    if (originalSubtle) {
      Object.defineProperty(globalThis.crypto, 'subtle', {
        value: originalSubtle,
        configurable: true,
      });
    }
  });

  it('returns the init payload immediately when the file already exists (dedup)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      id: 'att-1',
      uploadURL: 'http://upload/u',
      alreadyExists: true,
      filename: 'x.txt',
      contentType: 'text/plain',
      size: 1,
    });
    const onInit = vi.fn();
    const onProgress = vi.fn();
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });

    const result = await uploadAttachment(file, { onInit, onProgress });

    expect(result.id).toBe('att-1');
    expect(onInit).toHaveBeenCalledWith(expect.objectContaining({ id: 'att-1' }));
    expect(onProgress).toHaveBeenCalledWith(1);
    // No XHR upload because the server already had the bytes
    expect(XHRMock.last).toBeNull();
  });

  it('uploads via PUT and reports progress when the file is new', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      id: 'att-2',
      uploadURL: 'http://upload/u',
      alreadyExists: false,
      filename: 'x.txt',
      contentType: 'text/plain',
      size: 1,
    });
    const onProgress = vi.fn();
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });
    const promise = uploadAttachment(file, { onProgress });

    await waitFor(() => expect(XHRMock.last).not.toBeNull());
    const xhr = XHRMock.last!;
    expect(xhr.openedWith).toEqual({ method: 'PUT', url: 'http://upload/u' });

    // Half-way progress
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 50, total: 100 });
    // Same integer percent again — should be deduped (still no extra emit)
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 50, total: 100 });
    // Non-computable — ignored
    xhr.upload.onprogress!({ lengthComputable: false, loaded: 0, total: 0 });

    xhr.status = 200;
    xhr.onload!();

    await promise;
    // 0.5 from progress event + 1 from onload completion
    expect(onProgress).toHaveBeenCalledWith(0.5);
    expect(onProgress).toHaveBeenCalledWith(1);
  });

  it('rejects when the PUT returns a non-2xx status', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      id: 'att-3',
      uploadURL: 'http://upload/u',
      alreadyExists: false,
      filename: 'x.txt',
      contentType: 'text/plain',
      size: 1,
    });
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });
    const promise = uploadAttachment(file);
    await waitFor(() => expect(XHRMock.last).not.toBeNull());
    const xhr = XHRMock.last!;
    xhr.status = 500;
    xhr.onload!();
    await expect(promise).rejects.toThrow(/Upload failed: 500/);
  });

  it('rejects when the network errors out', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      id: 'att-4',
      uploadURL: 'http://upload/u',
      alreadyExists: false,
      filename: 'x.txt',
      contentType: 'text/plain',
      size: 1,
    });
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });
    const promise = uploadAttachment(file);
    await waitFor(() => expect(XHRMock.last).not.toBeNull());
    XHRMock.last!.onerror!();
    await expect(promise).rejects.toThrow(/network error/i);
  });
});

describe('useAttachment', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('does not fetch when id is undefined', () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAttachment(undefined), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('fetches the attachment metadata when an id is provided', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ id: 'a-1', filename: 'a.txt' });
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAttachment('a-1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/attachments/a-1');
  });
});

describe('useAttachmentsBatch', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('does not fetch when the id list is empty', () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAttachmentsBatch([]), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.map.size).toBe(0);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('fetches the batch and exposes a stable id→attachment map; hydrates per-id cache', async () => {
    const list = [
      { id: 'b', filename: 'b.txt', contentType: 'text/plain', size: 1 },
      { id: 'a', filename: 'a.txt', contentType: 'text/plain', size: 1 },
    ];
    vi.mocked(apiFetch).mockResolvedValueOnce(list);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { Wrapper } = createWrapper(qc);
    const { result } = renderHook(() => useAttachmentsBatch(['b', 'a']), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Sorted CSV key for stable cache hits
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/attachments?ids=a%2Cb');
    expect(result.current.map.get('a')).toEqual(list[1]);
    expect(result.current.map.get('b')).toEqual(list[0]);
    // Per-id cache was hydrated for inner useAttachment(id) calls
    expect(qc.getQueryData(['attachment', 'a'])).toEqual(list[1]);
    expect(qc.getQueryData(['attachment', 'b'])).toEqual(list[0]);
  });
});

describe('useDeleteDraftAttachment', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('issues a DELETE for the given attachment id', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(undefined);
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useDeleteDraftAttachment(), { wrapper: Wrapper });
    await result.current.mutateAsync('att-z');
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/attachments/att-z',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
