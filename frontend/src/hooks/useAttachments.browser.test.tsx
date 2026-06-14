import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach } from 'vitest';
import {
  useAttachment,
  useAttachmentsBatch,
  useDeleteDraftAttachment,
  uploadAttachment,
} from './useAttachments';
import { queryKeys } from '@/lib/query-keys';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
});

function Probe<T>({ hook }: { hook: () => { data?: T } }) {
  const r = hook();
  return <div data-testid="probe" data-data={r.data === undefined ? '' : JSON.stringify(r.data)} />;
}

function MutationTrigger({ hook, vars }: { hook: () => { mutate: (v: unknown) => void }; vars: unknown }) {
  const m = hook();
  return <button data-testid="trigger" onClick={() => m.mutate(vars)} />;
}

describe('useAttachment', () => {
  it('is disabled when id is missing', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <Probe hook={() => useAttachment(undefined)} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('fetches /attachments/:id without context query when ctx is omitted', async () => {
    apiFetchMock.mockResolvedValue({ id: 'a-1' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <Probe hook={() => useAttachment('a-1')} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/attachments/a-1');
  });

  it('appends a context query when parentID / parentType / messageID are supplied', async () => {
    apiFetchMock.mockResolvedValue({ id: 'a-1' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <Probe
          hook={() =>
            useAttachment('a-1', {
              parentID: 'ch-1',
              parentType: 'channel',
              messageID: 'm-1',
            })
          }
        />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    const url = apiFetchMock.mock.calls[0][0] as string;
    expect(url).toContain('parentID=ch-1');
    expect(url).toContain('parentType=channel');
    expect(url).toContain('messageID=m-1');
  });
});

describe('useAttachmentsBatch', () => {
  it('is disabled when the id list is empty', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <Probe hook={() => useAttachmentsBatch([])} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('uses a stable sorted cache key and hydrates per-id caches', async () => {
    apiFetchMock.mockResolvedValue([
      { id: 'a-1', filename: 'one' },
      { id: 'a-2', filename: 'two' },
    ]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function H() {
      const r = useAttachmentsBatch(['a-2', 'a-1']);
      return <span data-testid="probe" data-map={[...r.map.keys()].join(',')} />;
    }
    const screen = await render(
      <QueryClientProvider client={qc}>
        <H />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect((apiFetchMock.mock.calls[0][0] as string)).toContain('ids=a-1%2Ca-2');
    expect(screen.getByTestId('probe').element().getAttribute('data-map')).toBe('a-1,a-2');
    // Per-id cache hydration:
    expect(qc.getQueryData(queryKeys.attachment('a-1'))).toEqual({ id: 'a-1', filename: 'one' });
    expect(qc.getQueryData(queryKeys.attachment('a-2'))).toEqual({ id: 'a-2', filename: 'two' });
  });
});

// A 1×1 PNG so readImageDimensions' Image actually decodes (covering the
// naturalWidth/Height branch).
function pngFile(name = 'pixel.png') {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type: 'image/png' });
}

interface ProgressLike { lengthComputable: boolean; loaded: number; total: number }
const xhrConfig = { status: 200, fireError: false };
class FakeXHR {
  upload: { onprogress?: (e: ProgressLike) => void } = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  open() {}
  setRequestHeader() {}
  send() {
    if (xhrConfig.fireError) { this.onerror?.(); return; }
    // lengthComputable progress; a repeat at the same integer % is dropped,
    // a non-computable tick is ignored.
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    this.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    this.status = xhrConfig.status;
    this.onload?.();
  }
}

describe('uploadAttachment', () => {
  let realXHR: typeof XMLHttpRequest;
  beforeEach(() => {
    realXHR = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    xhrConfig.status = 200;
    xhrConfig.fireError = false;
  });
  afterEach(() => {
    globalThis.XMLHttpRequest = realXHR;
  });

  it('short-circuits when the server already has the content (alreadyExists)', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ id: 'a-1', uploadURL: 'https://up/x', alreadyExists: true, filename: 'pixel.png', contentType: 'image/png', size: 70, width: 1, height: 1 })
      .mockResolvedValueOnce(undefined); // process
    const onInit = vi.fn();
    const onProgress = vi.fn();
    const init = await uploadAttachment(pngFile(), { onInit, onProgress });
    expect(init.id).toBe('a-1');
    expect(onInit).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(1);
    // POST init carries the decoded image dimensions.
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.width).toBe(1);
    expect(body.height).toBe(1);
    // The /process endpoint was called.
    expect(apiFetchMock.mock.calls.some((c) => String(c[0]).includes('/process'))).toBe(true);
  });

  it('uploads a new (non-image, untyped) file via XHR with progress', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ id: 'a-2', uploadURL: 'https://up/y', alreadyExists: false, filename: 'blob', contentType: '', size: 4 })
      .mockResolvedValueOnce(undefined);
    const onProgress = vi.fn();
    const file = new File(['data'], 'blob', { type: '' });
    const init = await uploadAttachment(file, { onProgress });
    expect(init.id).toBe('a-2');
    // contentType fell back to application/octet-stream for the untyped file.
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.contentType).toBe('application/octet-stream');
    // Progress ticks were forwarded and the final completion is 1.
    expect(onProgress).toHaveBeenLastCalledWith(1);
    expect(onProgress.mock.calls.length).toBeGreaterThan(1);
  });

  it('rejects when the XHR upload returns a non-2xx status', async () => {
    apiFetchMock.mockResolvedValueOnce({ id: 'a-3', uploadURL: 'https://up/z', alreadyExists: false, filename: 'f', contentType: 'text/plain', size: 4 });
    xhrConfig.status = 500;
    await expect(uploadAttachment(new File(['x'], 'f.txt', { type: 'text/plain' }))).rejects.toThrow(/Upload failed: 500/);
  });

  it('rejects on an XHR network error', async () => {
    apiFetchMock.mockResolvedValueOnce({ id: 'a-4', uploadURL: 'https://up/w', alreadyExists: false, filename: 'f', contentType: 'text/plain', size: 4 });
    xhrConfig.fireError = true;
    await expect(uploadAttachment(new File(['x'], 'f.txt', { type: 'text/plain' }))).rejects.toThrow(/network error/);
  });
});

describe('useDeleteDraftAttachment', () => {
  it('DELETEs the attachment by id', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <MutationTrigger hook={useDeleteDraftAttachment as never} vars="a-1" />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/attachments/a-1');
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('DELETE');
  });
});
