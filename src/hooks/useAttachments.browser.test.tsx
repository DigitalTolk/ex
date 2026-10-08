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

  it('coerces an empty attachment response to null', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Probe hook={() => useAttachment('a-1')} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('null');
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

  it('forwards parentID / parentType / messageID in the batch request', async () => {
    apiFetchMock.mockResolvedValue([{ id: 'a-9', filename: 'nine' }]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <Probe hook={() => useAttachmentsBatch(['a-9'], { parentID: 'ch-7', parentType: 'channel', messageID: 'm-7' })} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    const url = apiFetchMock.mock.calls[0][0] as string;
    expect(url).toContain('parentID=ch-7');
    expect(url).toContain('parentType=channel');
    expect(url).toContain('messageID=m-7');
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
// A fake S3 endpoint for the real Uppy uploader: each send reports progress
// over the actual body and answers with the next configured outcome
// ('ok' → 200 + ETag, a status code, or 'drop' for a network error).
const xhrConfig: { outcomes: Array<'ok' | 'drop' | number>; sends: number; headers: Array<Record<string, string>> } = {
  outcomes: [],
  sends: 0,
  headers: [],
};
class FakeXHR {
  upload: { onprogress?: (e: ProgressLike) => void } = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  statusText = '';
  responseText = '';
  withCredentials = false;
  responseType = '';
  private requestHeaders: Record<string, string> = {};
  open() {}
  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }
  getResponseHeader(name: string) {
    return name.toLowerCase() === 'etag' && this.status === 200 ? '"etag"' : null;
  }
  abort() {}
  send(body: Blob | null) {
    xhrConfig.sends += 1;
    xhrConfig.headers.push(this.requestHeaders);
    const outcome = xhrConfig.outcomes.shift() ?? 'ok';
    const total = body?.size ?? 0;
    setTimeout(() => {
      if (outcome === 'drop') {
        this.onerror?.();
        return;
      }
      this.upload.onprogress?.({ lengthComputable: true, loaded: Math.floor(total / 2), total });
      this.upload.onprogress?.({ lengthComputable: true, loaded: total, total });
      this.status = outcome === 'ok' ? 200 : outcome;
      this.statusText = String(this.status);
      this.responseText = outcome === 'ok' ? '' : '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';
      this.onload?.();
    }, 0);
  }
}

// Route the API by path: upload-init, the signed S3 request, processing.
function routeUpload(init: Record<string, unknown>) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/api/v1/attachments/url') return Promise.resolve({ key: `attachments/${init.id}`, multipartUploadId: '', ...init });
    if (path.endsWith('/upload-request')) {
      return Promise.resolve({ url: `https://s3.test/attachments/${init.id}`, key: `attachments/${init.id}`, headers: { 'Content-Type': 'application/octet-stream' } });
    }
    return Promise.resolve(undefined);
  });
}

describe('uploadAttachment', () => {
  let realXHR: typeof XMLHttpRequest;
  beforeEach(() => {
    realXHR = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    xhrConfig.outcomes = [];
    xhrConfig.sends = 0;
    xhrConfig.headers = [];
  });
  afterEach(() => {
    globalThis.XMLHttpRequest = realXHR;
  });

  it('short-circuits when the server already has the content (alreadyExists)', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ id: 'a-1', key: 'attachments/a-1', multipartUploadId: '', alreadyExists: true, filename: 'pixel.png', contentType: 'image/png', size: 70, width: 1, height: 1 })
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
    // The /process endpoint was called, and nothing went to S3.
    expect(apiFetchMock.mock.calls.some((c) => String(c[0]).includes('/process'))).toBe(true);
    expect(xhrConfig.sends).toBe(0);
  });

  it('uploads a new (non-image, untyped) file to S3 with progress', async () => {
    routeUpload({ id: 'a-2', alreadyExists: false, filename: 'blob', contentType: '', size: 4 });
    const onProgress = vi.fn();
    const file = new File(['data'], 'blob', { type: '' });
    const init = await uploadAttachment(file, { onProgress });
    expect(init.id).toBe('a-2');
    // contentType fell back to application/octet-stream for the untyped file.
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.contentType).toBe('application/octet-stream');
    // One signed PUT carrying the signed headers.
    expect(xhrConfig.sends).toBe(1);
    expect(xhrConfig.headers[0]['Content-Type']).toBe('application/octet-stream');
    // Progress ticks were forwarded (the upload's share tops out at 0.9) and
    // the final completion is 1.
    expect(onProgress).toHaveBeenCalledWith(0.45);
    expect(onProgress).toHaveBeenCalledWith(0.9);
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  it('uploads an undecodable image without dimensions (Image onerror branch)', async () => {
    routeUpload({ id: 'a-5', alreadyExists: false, filename: 'broken.png', contentType: 'image/png', size: 3 });
    // Garbage bytes with an image/* type: readImageDimensions creates an Image
    // whose decode fails → img.onerror fires → resolve({}) (no width/height),
    // exercising the `{}` side of the `w > 0 && h > 0` resolve.
    const file = new File([Uint8Array.from([1, 2, 3])], 'broken.png', { type: 'image/png' });
    const init = await uploadAttachment(file);
    expect(init.id).toBe('a-5');
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.width).toBeUndefined();
    expect(body.height).toBeUndefined();
  });

  it('rejects without retrying when S3 refuses the upload', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    routeUpload({ id: 'a-3', alreadyExists: false, filename: 'f', contentType: 'text/plain', size: 1 });
    xhrConfig.outcomes = [403];
    await expect(uploadAttachment(new File(['x'], 'f.txt', { type: 'text/plain' }))).rejects.toThrow(/403/);
    expect(xhrConfig.sends).toBe(1);
    expect(apiFetchMock.mock.calls.some((c) => String(c[0]).includes('/process'))).toBe(false);
    error.mockRestore();
  });

  it('retries a dropped connection and completes the upload', async () => {
    routeUpload({ id: 'a-4', alreadyExists: false, filename: 'f', contentType: 'text/plain', size: 1 });
    xhrConfig.outcomes = ['drop', 'ok'];
    const init = await uploadAttachment(new File(['x'], 'f.txt', { type: 'text/plain' }));
    expect(init.id).toBe('a-4');
    expect(xhrConfig.sends).toBe(2);
    expect(apiFetchMock.mock.calls.some((c) => String(c[0]).includes('/process'))).toBe(true);
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
