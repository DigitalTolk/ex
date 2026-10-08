import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  apiFetch: apiFetchMock,
}));

import { HASH_CHUNK_BYTES, sha256File, uploadAttachment } from '@/hooks/useAttachments';

class MockXMLHttpRequest {
  static uploads: Array<{ url: string; contentType: string; body: unknown }> = [];
  upload = {};
  status = 204;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private url = '';
  private contentType = '';

  open(_method: string, url: string) {
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    if (name.toLowerCase() === 'content-type') {
      this.contentType = value;
    }
  }

  getResponseHeader(name: string) {
    return name.toLowerCase() === 'etag' ? '"etag"' : null;
  }

  abort() {}

  send(body: unknown) {
    MockXMLHttpRequest.uploads.push({ url: this.url, contentType: this.contentType, body });
    setTimeout(() => this.onload?.(), 0);
  }
}

// Route the API by path: upload-init, then one signed S3 request (a single
// PUT for these small files), then processing.
function routeUpload(init: Record<string, unknown>) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/api/v1/attachments/url') return Promise.resolve(init);
    if (path.endsWith('/upload-request')) {
      return Promise.resolve({ url: 'https://upload.example.test/original', key: init.key, headers: {} });
    }
    return Promise.resolve({ id: init.id });
  });
}

describe('uploadAttachment processing', () => {
  const originalXHR = globalThis.XMLHttpRequest;
  const originalImage = globalThis.Image;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    apiFetchMock.mockReset();
    MockXMLHttpRequest.uploads = [];
    globalThis.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    globalThis.Image = class {
      naturalWidth = 1200;
      naturalHeight = 800;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    } as unknown as typeof Image;
  });

  afterEach(() => {
    globalThis.XMLHttpRequest = originalXHR;
    globalThis.Image = originalImage;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('uploads only the original and then asks the backend to process thumbnails', async () => {
    routeUpload({
      id: 'att-1',
      key: 'attachments/att-1',
      multipartUploadId: '',
      alreadyExists: false,
      filename: 'photo.png',
      contentType: 'image/png',
      size: 5,
    });

    await uploadAttachment(new File(['photo'], 'photo.png', { type: 'image/png' }));

    expect(MockXMLHttpRequest.uploads.map((upload) => upload.url)).toEqual([
      'https://upload.example.test/original',
    ]);
    expect(MockXMLHttpRequest.uploads[0].contentType).toBe('image/png');
    expect(apiFetchMock).toHaveBeenLastCalledWith('/api/v1/attachments/att-1/process', {
      method: 'POST',
    });
  });

  it('processes deduped existing attachments without re-uploading bytes', async () => {
    apiFetchMock
      .mockResolvedValueOnce({
        id: 'att-1',
        key: 'attachments/att-1',
        multipartUploadId: '',
        alreadyExists: true,
        filename: 'photo.png',
        contentType: 'image/png',
        size: 5,
      })
      .mockResolvedValueOnce({ id: 'att-1' });

    await uploadAttachment(new File(['photo'], 'photo.png', { type: 'image/png' }));

    expect(MockXMLHttpRequest.uploads).toEqual([]);
    expect(apiFetchMock).toHaveBeenNthCalledWith(2, '/api/v1/attachments/att-1/process', {
      method: 'POST',
    });
  });

  // Regression: the upload used to read the whole file with file.arrayBuffer()
  // and digest it with WebCrypto, holding the entire file (plus a copy) in the
  // tab — large attachments crashed webviews and the desktop renderer.
  it('hashes large files in bounded chunks instead of reading them whole', async () => {
    routeUpload({
      id: 'att-big',
      key: 'attachments/att-big',
      multipartUploadId: '',
      alreadyExists: false,
      filename: 'big.bin',
      contentType: 'application/octet-stream',
      size: HASH_CHUNK_BYTES * 2 + 3,
    });
    const bytes = new Uint8Array(HASH_CHUNK_BYTES * 2 + 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    const file = new File([bytes], 'big.bin', { type: 'application/octet-stream' });
    const wholeRead = vi.spyOn(file, 'arrayBuffer');
    const slice = vi.spyOn(file, 'slice');

    await uploadAttachment(file);

    expect(wholeRead).not.toHaveBeenCalled();
    expect(slice).toHaveBeenCalledTimes(3);
    for (const [start, end] of slice.mock.calls) {
      expect((end as number) - (start as number)).toBeLessThanOrEqual(HASH_CHUNK_BYTES);
    }
    const init = JSON.parse(apiFetchMock.mock.calls[0][1].body as string);
    expect(init.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(init.size).toBe(bytes.length);
  });

  it('produces the standard SHA-256 digest across chunk boundaries', async () => {
    const abc = new Blob(['abc']);
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(await sha256File(abc)).toBe(expected);
    expect(await sha256File(abc, 1)).toBe(expected);
    expect(await sha256File(abc, 2)).toBe(expected);
    expect(await sha256File(new Blob([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
