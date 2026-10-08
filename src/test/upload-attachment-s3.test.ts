import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  apiFetch: apiFetchMock,
}));

import { MULTIPART_THRESHOLD_BYTES, uploadAttachment } from '@/hooks/useAttachments';

// The real Uppy S3 plugin runs against this fake bucket, so the test covers
// the actual request sequence the browser makes: what it asks the server to
// sign, and what it then sends to S3.
interface S3Request {
  method: string;
  url: URL;
  headers: Record<string, string>;
  size: number;
}

class FakeS3 {
  requests: S3Request[] = [];
  // uploadId → part numbers already stored.
  uploads = new Map<string, Set<number>>();
  failSinglePut = 0;

  respond(req: S3Request): { status: number; body: string; etag?: string } {
    const q = req.url.searchParams;
    const uploadId = q.get('uploadId');
    if (req.method === 'PUT' && !uploadId) {
      return this.failSinglePut ? { status: this.failSinglePut, body: '<Error><Code>AccessDenied</Code><Message>denied</Message></Error>' } : { status: 200, body: '', etag: '"single"' };
    }
    if (req.method === 'POST' && q.has('uploads')) {
      this.uploads.set('mpu-new', new Set());
      return { status: 200, body: '<InitiateMultipartUploadResult><UploadId>mpu-new</UploadId></InitiateMultipartUploadResult>' };
    }
    const parts = uploadId ? this.uploads.get(uploadId) : undefined;
    if (!parts) {
      return { status: 404, body: '<Error><Code>NoSuchUpload</Code><Message>gone</Message></Error>' };
    }
    if (req.method === 'PUT') {
      const n = Number(q.get('partNumber'));
      parts.add(n);
      return { status: 200, body: '', etag: `"p${n}"` };
    }
    if (req.method === 'GET') {
      const listed = [...parts].map((n) => `<Part><PartNumber>${n}</PartNumber><ETag>"p${n}"</ETag><Size>1</Size></Part>`).join('');
      return { status: 200, body: `<ListPartsResult>${listed}</ListPartsResult>` };
    }
    return { status: 200, body: '<CompleteMultipartUploadResult><Location>https://s3.test/x</Location><Key>x</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>' };
  }
}

let s3: FakeS3;

class FakeXHR {
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  statusText = '';
  responseText = '';
  response = '';
  readyState = 0;
  withCredentials = false;
  responseType = '';
  private method = '';
  private url = '';
  private headers: Record<string, string> = {};
  private etag: string | undefined;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader(name: string) {
    return name.toLowerCase() === 'etag' ? (this.etag ?? null) : null;
  }
  abort() {}
  send(body: Blob | string | null) {
    const size = body instanceof Blob ? body.size : (body?.length ?? 0);
    const req = { method: this.method, url: new URL(this.url), headers: { ...this.headers }, size };
    s3.requests.push(req);
    setTimeout(() => {
      const res = s3.respond(req);
      this.upload.onprogress?.({ lengthComputable: true, loaded: size, total: size } as ProgressEvent);
      this.status = res.status;
      this.statusText = String(res.status);
      this.responseText = res.body;
      this.response = res.body;
      this.readyState = 4;
      this.etag = res.etag;
      this.onload?.();
    }, 0);
  }
}

// The server side of signing: echo the request as an S3 URL with the right
// sub-resource, plus the headers a real signature would bind.
function signedURLFor(id: string, init: { body: string }) {
  const req = JSON.parse(init.body) as { method: string; key: string; uploadId?: string; partNumber?: number };
  const q = new URLSearchParams();
  const headers: Record<string, string> = {};
  if (!req.uploadId && req.method === 'PUT') {
    headers['Content-Type'] = 'application/pdf';
    headers['x-amz-checksum-sha256'] = 'c2lnbmVk';
  } else if (!req.uploadId) {
    q.set('uploads', '');
    headers['Content-Type'] = 'application/zip';
  } else {
    q.set('uploadId', req.uploadId);
    if (req.partNumber) q.set('partNumber', String(req.partNumber));
  }
  return { url: `https://s3.test/${req.key}?${q.toString()}&att=${id}`, key: req.key, headers };
}

function routeAPI(init: { id: string; multipartUploadId?: string }) {
  apiFetchMock.mockImplementation((path: string, opts: { body: string }) => {
    if (path === '/api/v1/attachments/url') {
      return Promise.resolve({
        id: init.id,
        key: `attachments/${init.id}`,
        multipartUploadId: init.multipartUploadId ?? '',
        alreadyExists: false,
        filename: 'f',
        contentType: 'application/octet-stream',
        size: 1,
      });
    }
    if (path.endsWith('/upload-request')) return Promise.resolve(signedURLFor(init.id, opts));
    return Promise.resolve({ id: init.id });
  });
}

function signCalls() {
  return apiFetchMock.mock.calls
    .filter(([path]) => String(path).endsWith('/upload-request'))
    .map(([, opts]) => JSON.parse((opts as { body: string }).body) as { method: string; uploadId?: string; partNumber?: number });
}

function processCalls() {
  return apiFetchMock.mock.calls.filter(([path]) => String(path).endsWith('/process'));
}

const bigFile = () =>
  new File([new Uint8Array(MULTIPART_THRESHOLD_BYTES + 1)], 'big.zip', { type: 'application/zip' });

describe('uploadAttachment → S3', () => {
  const originalXHR = globalThis.XMLHttpRequest;

  beforeEach(() => {
    apiFetchMock.mockReset();
    s3 = new FakeS3();
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  });

  afterEach(() => {
    globalThis.XMLHttpRequest = originalXHR;
  });

  it('sends a small file in one PUT carrying exactly the signed headers', async () => {
    routeAPI({ id: 'att-small' });
    const progress = vi.fn();
    // No browser-detected type: the signed Content-Type must still win.
    await uploadAttachment(new File(['%PDF-1.7'], 'spec.pdf', { type: '' }), { onProgress: progress });

    expect(signCalls()).toEqual([{ method: 'PUT', key: 'attachments/att-small' }]);
    expect(s3.requests).toHaveLength(1);
    expect(s3.requests[0].method).toBe('PUT');
    expect(s3.requests[0].url.pathname).toBe('/attachments/att-small');
    expect(s3.requests[0].headers['Content-Type']).toBe('application/pdf');
    expect(s3.requests[0].headers['x-amz-checksum-sha256']).toBe('c2lnbmVk');
    expect(processCalls()).toHaveLength(1);
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('sends a large file as a multipart upload, part by part', async () => {
    routeAPI({ id: 'att-big' });
    await uploadAttachment(bigFile());

    expect(signCalls().map((c) => [c.method, c.partNumber ?? null])).toEqual([
      ['POST', null],
      ['PUT', 1],
      ['PUT', 2],
      ['PUT', 3],
      ['PUT', 4],
      ['POST', null],
    ]);
    const partSizes = s3.requests.filter((r) => r.url.searchParams.has('partNumber')).map((r) => r.size);
    expect(partSizes).toEqual([5 * 1024 * 1024, 5 * 1024 * 1024, 5 * 1024 * 1024, 1024 * 1024 + 1]);
    expect(s3.requests.at(-1)?.url.searchParams.get('uploadId')).toBe('mpu-new');
    expect(processCalls()).toHaveLength(1);
  });

  // Re-attaching a file whose upload never finished picks up the multipart
  // upload the server remembered: only the missing parts are sent.
  it('resumes an open multipart upload instead of starting over', async () => {
    s3.uploads.set('mpu-old', new Set([1, 2]));
    routeAPI({ id: 'att-resume', multipartUploadId: 'mpu-old' });
    await uploadAttachment(bigFile());

    expect(signCalls().map((c) => [c.method, c.uploadId, c.partNumber ?? null])).toEqual([
      ['GET', 'mpu-old', null],
      ['PUT', 'mpu-old', 3],
      ['PUT', 'mpu-old', 4],
      ['POST', 'mpu-old', null],
    ]);
    expect(s3.requests.some((r) => r.url.searchParams.has('uploads'))).toBe(false);
    expect(processCalls()).toHaveLength(1);
  });

  it('starts a fresh upload when the remembered one is gone from S3', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    routeAPI({ id: 'att-stale', multipartUploadId: 'mpu-gone' });
    await uploadAttachment(bigFile());

    const calls = signCalls();
    expect(calls[0]).toMatchObject({ method: 'GET', uploadId: 'mpu-gone' });
    expect(calls[1]).toMatchObject({ method: 'POST' });
    expect(calls[1].uploadId).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', uploadId: 'mpu-new' });
    expect(processCalls()).toHaveLength(1);
    error.mockRestore();
  });

  it('fails without processing when S3 refuses the upload', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    s3.failSinglePut = 403;
    routeAPI({ id: 'att-denied' });
    await expect(uploadAttachment(new File(['x'], 'a.pdf', { type: 'application/pdf' }))).rejects.toThrow();
    expect(processCalls()).toHaveLength(0);
    error.mockRestore();
  });
});
