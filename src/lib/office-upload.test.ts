import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { clearAccessToken, setAccessToken } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { composerValue, isOfficeFile, keepsOfficeFilesInOneDrive, officeFileLink, putOfficeFile } from './office-upload';

describe('isOfficeFile', () => {
  it('knows Word, Excel and PowerPoint files, old and new', () => {
    for (const name of ['a.doc', 'a.DOCX', 'b.xls', 'b.xlsx', 'c.ppt', 'c.pptx']) expect(isOfficeFile(name)).toBe(true);
    for (const name of ['a.pdf', 'a.docx.txt', 'docx', 'a.odt']) expect(isOfficeFile(name)).toBe(false);
  });
});

describe('keepsOfficeFilesInOneDrive', () => {
  const qc = (settings: unknown) => {
    const c = new QueryClient();
    if (settings) c.setQueryData(queryKeys.workspaceSettings(), settings);
    return c;
  };

  it('is on while SharePoint sharing is on, and off otherwise or before the settings load', () => {
    expect(keepsOfficeFilesInOneDrive(qc({ sharePointHosts: ['*.sharepoint.com'] }))).toBe(true);
    expect(keepsOfficeFilesInOneDrive(qc({ sharePointHosts: [] }))).toBe(false);
    expect(keepsOfficeFilesInOneDrive(qc({}))).toBe(false);
    expect(keepsOfficeFilesInOneDrive(qc(null))).toBe(false);
  });
});

describe('officeFileLink', () => {
  it('escapes what would end the link early', () => {
    expect(officeFileLink({ name: 'Plan [v2] \\ final.docx', webURL: 'https://x.sharepoint.com/a(1).docx', size: 1 })).toBe(
      '[Plan \\[v2\\] \\\\ final.docx](https://x.sharepoint.com/a%281%29.docx)',
    );
  });
});

describe('composerValue', () => {
  it('sends attachments by id and OneDrive files as links after the text', () => {
    const chips = [{ id: 'att-1' }, { id: 'pending-2', link: '[a.docx](https://x/a)' }, { id: 'pending-3', link: '[b.xlsx](https://x/b)' }];
    expect(composerValue('see these', chips)).toEqual({ body: 'see these\n[a.docx](https://x/a)\n[b.xlsx](https://x/b)', attachmentIDs: ['att-1'] });
    expect(composerValue('', chips.slice(1, 2))).toEqual({ body: '[a.docx](https://x/a)', attachmentIDs: [] });
    expect(composerValue('hi', [])).toEqual({ body: 'hi', attachmentIDs: [] });
  });
});

describe('putOfficeFile', () => {
  // A stand-in XMLHttpRequest that answers as the test says.
  class FakeXHR {
    static last: FakeXHR;
    static answer: { status: number; response: unknown } | 'network-error' = { status: 201, response: null };
    method = '';
    url = '';
    headers: Record<string, string> = {};
    withCredentials = false;
    responseType = '';
    status = 0;
    response: unknown = null;
    body: unknown;
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      FakeXHR.last = this;
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    send(body: unknown) {
      this.body = body;
      this.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 });
      const a = FakeXHR.answer;
      if (a === 'network-error') return this.onerror?.();
      this.status = a.status;
      this.response = a.response;
      this.onload?.();
    }
  }
  const file = new File(['hello'], 'Q3 plan & more.docx');

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAccessToken();
  });

  it('sends the file as the user, reporting progress, and answers with the file in OneDrive', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    setAccessToken('tok-1');
    const up = { name: 'Q3 plan & more.docx', webURL: 'https://x.sharepoint.com/q3.docx', size: 5 };
    FakeXHR.answer = { status: 201, response: up };
    const progress = vi.fn();
    await expect(putOfficeFile({ type: 'channel', id: 'ch/1' }, file, progress)).resolves.toEqual(up);
    const xhr = FakeXHR.last;
    expect([xhr.method, xhr.url]).toEqual(['PUT', '/api/v1/channels/ch%2F1/office-files?name=Q3%20plan%20%26%20more.docx']);
    expect(xhr.headers).toEqual({ Authorization: 'Bearer tok-1' });
    expect([xhr.withCredentials, xhr.responseType, xhr.body]).toEqual([true, 'json', file]);
    expect(progress.mock.calls).toEqual([[0.5]]);
    // A DM's goes to the conversation's.
    await expect(putOfficeFile({ type: 'conversation', id: 'dm-1' }, file, progress)).resolves.toEqual(up);
    expect(FakeXHR.last.url).toBe('/api/v1/conversations/dm-1/office-files?name=Q3%20plan%20%26%20more.docx');
  });

  it('refuses anything but the file: another status, no link, or no answer at all', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    for (const answer of [{ status: 409, response: { error: 'sign in' } }, { status: 201, response: null }, { status: 201, response: {} }]) {
      FakeXHR.answer = answer;
      await expect(putOfficeFile({ type: 'channel', id: 'ch-1' }, file, vi.fn())).rejects.toThrow(`OneDrive upload refused (${answer.status})`);
    }
    // Signed out: no token to send.
    expect(FakeXHR.last.headers).toEqual({});
    FakeXHR.answer = 'network-error';
    await expect(putOfficeFile({ type: 'channel', id: 'ch-1' }, file, vi.fn())).rejects.toThrow('OneDrive upload failed');
  });
});
