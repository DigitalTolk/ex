import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  apiFetch: apiFetchMock,
}));

import { uploadAttachment } from '@/hooks/useAttachments';

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

  send(body: unknown) {
    MockXMLHttpRequest.uploads.push({ url: this.url, contentType: this.contentType, body });
    this.onload?.();
  }
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
    apiFetchMock
      .mockResolvedValueOnce({
        id: 'att-1',
        uploadURL: 'https://upload.example.test/original',
        alreadyExists: false,
        filename: 'photo.png',
        contentType: 'image/png',
        size: 5,
      })
      .mockResolvedValueOnce({ id: 'att-1' });

    await uploadAttachment(new File(['photo'], 'photo.png', { type: 'image/png' }));

    expect(MockXMLHttpRequest.uploads.map((upload) => upload.url)).toEqual([
      'https://upload.example.test/original',
    ]);
    expect(MockXMLHttpRequest.uploads[0].contentType).toBe('image/png');
    expect(apiFetchMock).toHaveBeenNthCalledWith(2, '/api/v1/attachments/att-1/process', {
      method: 'POST',
    });
  });

  it('processes deduped existing attachments without re-uploading bytes', async () => {
    apiFetchMock
      .mockResolvedValueOnce({
        id: 'att-1',
        uploadURL: '',
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
});
