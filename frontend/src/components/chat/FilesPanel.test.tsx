import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react'; // waitFor used below in flow tests
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { FilesPanel } from './FilesPanel';
import { attachmentURLForFile } from './files-panel-url';

// Unit-test coverage for the files side panel. Catches the bug class
// where the panel mounts but never lists files (or lists rows that
// never resolve their attachment metadata) — both shapes were missing
// from the browser smoke test and let "files panel is blank" slip
// through.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// The lightbox subtree pulls in ImageLightbox + lightbox-gestures which
// are jsdom-hostile (PointerEvent, ResizeObserver, animation frames).
// Stubbing the hook keeps this unit test focused on the row-rendering
// surface — the lightbox itself has its own tests.
vi.mock('@/hooks/useAttachmentLightbox', () => ({
  useAttachmentLightbox: ({ sources }: { sources: { key: string; slide: unknown }[] }) => ({
    isOpenable: (k: string) => !!sources.find((s) => s.key === k && s.slide),
    open: vi.fn(),
    lightbox: null,
  }),
}));

interface FileEntry {
  attachmentID: string;
  messageID: string;
  authorID: string;
  createdAt: string;
}
interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url?: string;
  downloadURL?: string;
  squareThumbnailURL?: string;
}

function setupAPI(opts: { files?: FileEntry[]; attachments?: Record<string, Attachment>; filesError?: boolean }) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string) => {
    if (typeof url !== 'string') return Promise.resolve(null);
    if (url.endsWith('/files')) {
      if (opts.filesError) return Promise.reject(new Error('boom'));
      return Promise.resolve(opts.files ?? []);
    }
    const m = url.match(/\/attachments\/([^?]+)/);
    if (m) {
      const att = opts.attachments?.[m[1]];
      return att ? Promise.resolve(att) : Promise.reject(new Error('not found'));
    }
    return Promise.resolve(null);
  });
}

function renderPanel(props?: Partial<Parameters<typeof FilesPanel>[0]>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <FilesPanel
          channelId="ch-1"
          onClose={vi.fn()}
          userMap={{ 'u-1': { displayName: 'Alice' } }}
          postedIn="~general"
          {...props}
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('attachmentURLForFile — every-context-permutation', () => {
  const entry = { attachmentID: 'a-1', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-01-01T00:00:00Z' };

  it('appends parentID + parentType + messageID when all are set', () => {
    expect(attachmentURLForFile(entry, 'ch-1', 'channel')).toBe(
      '/api/v1/attachments/a-1?parentID=ch-1&parentType=channel&messageID=m-1',
    );
  });

  it('drops the parentID param when undefined, keeps the others', () => {
    expect(attachmentURLForFile(entry, undefined, 'channel')).toBe(
      '/api/v1/attachments/a-1?parentType=channel&messageID=m-1',
    );
  });

  it('drops the parentType param when undefined', () => {
    expect(attachmentURLForFile(entry, 'ch-1', undefined)).toBe(
      '/api/v1/attachments/a-1?parentID=ch-1&messageID=m-1',
    );
  });

  it('drops the messageID param when the entry has no messageID', () => {
    expect(attachmentURLForFile({ ...entry, messageID: '' }, 'ch-1', 'channel')).toBe(
      '/api/v1/attachments/a-1?parentID=ch-1&parentType=channel',
    );
  });

  it('returns the path with no query string when nothing is present', () => {
    expect(attachmentURLForFile({ ...entry, messageID: '' }, undefined, undefined)).toBe(
      '/api/v1/attachments/a-1',
    );
  });
});

describe('FilesPanel', () => {
  it('renders the panel header and close button', async () => {
    setupAPI({ files: [] });
    renderPanel();
    expect(await screen.findByText('Files')).toBeTruthy();
    expect(document.querySelector('button[aria-label*="lose"]')).toBeTruthy();
  });

  it('shows the empty-state copy when no files are shared', async () => {
    setupAPI({ files: [] });
    renderPanel();
    expect(await screen.findByTestId('files-empty')).toBeTruthy();
  });

  it('does not call /files when neither channelId nor conversationId is set', async () => {
    setupAPI({});
    renderPanel({ channelId: undefined, conversationId: undefined });
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('calls /api/v1/channels/<id>/files for a channel scope', async () => {
    setupAPI({ files: [] });
    renderPanel({ channelId: 'ch-42' });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-42/files');
  });

  it('calls /api/v1/conversations/<id>/files for a conversation scope', async () => {
    setupAPI({ files: [] });
    renderPanel({ channelId: undefined, conversationId: 'cv-7' });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/conversations/cv-7/files');
  });

  it('renders one row per FileEntry with filename + author + size', async () => {
    setupAPI({
      files: [{ attachmentID: 'a-1', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' }],
      attachments: { 'a-1': { id: 'a-1', filename: 'spec.pdf', contentType: 'application/pdf', size: 12345, url: 'https://cdn/spec.pdf' } },
    });
    renderPanel();
    expect(await screen.findByText('spec.pdf')).toBeTruthy();
    expect(screen.getByText(/Alice/)).toBeTruthy();
    expect(screen.getByText(/KB/)).toBeTruthy();
    expect(document.querySelectorAll('[data-testid="files-row"]').length).toBe(1);
  });

  it('renders a thumbnail when the attachment is an image with a squareThumbnailURL', async () => {
    setupAPI({
      files: [{ attachmentID: 'img-1', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' }],
      attachments: {
        'img-1': {
          id: 'img-1', filename: 'cat.png', contentType: 'image/png', size: 5000,
          url: 'https://cdn/cat.png', squareThumbnailURL: 'https://cdn/cat-thumb.png',
        },
      },
    });
    renderPanel();
    const thumb = await screen.findByTestId('files-row-thumb') as HTMLImageElement;
    expect(thumb.src).toContain('cat-thumb.png');
  });

  it('falls back to the file-type icon for non-image attachments', async () => {
    setupAPI({
      files: [{ attachmentID: 'pdf-1', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' }],
      attachments: { 'pdf-1': { id: 'pdf-1', filename: 'spec.pdf', contentType: 'application/pdf', size: 1, url: 'https://cdn/spec.pdf' } },
    });
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-testid="files-row-icon"]')).toBeTruthy());
    expect(document.querySelector('[data-testid="files-row-thumb"]')).toBeFalsy();
  });

  it('substitutes "Unknown" for an unknown authorID', async () => {
    setupAPI({
      files: [{ attachmentID: 'a-1', messageID: 'm-1', authorID: 'u-MIA', createdAt: '2026-05-01T12:00:00Z' }],
      attachments: { 'a-1': { id: 'a-1', filename: 'mystery.txt', contentType: 'text/plain', size: 1, url: 'https://cdn/x.txt' } },
    });
    renderPanel({ userMap: {} });
    expect(await screen.findByText(/Unknown/)).toBeTruthy();
  });

  it('renders the download link using attachment.downloadURL when present', async () => {
    setupAPI({
      files: [{ attachmentID: 'a-1', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' }],
      attachments: {
        'a-1': {
          id: 'a-1', filename: 'plan.txt', contentType: 'text/plain', size: 1,
          url: 'https://cdn/signed-view', downloadURL: 'https://cdn/signed-download',
        },
      },
    });
    renderPanel();
    const link = (await screen.findByTestId('files-row-download')) as HTMLAnchorElement;
    expect(link.href).toContain('signed-download');
    expect(link.getAttribute('download')).toBe('plan.txt');
  });

  it('does not render the download link until the attachment metadata resolves', async () => {
    setupAPI({
      files: [{ attachmentID: 'missing', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' }],
    });
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-testid="files-row"]')).toBeTruthy());
    expect(document.querySelector('[data-testid="files-row-download"]')).toBeFalsy();
  });

  it('disables the open button until the attachment metadata has resolved', async () => {
    setupAPI({
      files: [{ attachmentID: 'pending', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' }],
      attachments: {},
    });
    renderPanel();
    const btn = (await screen.findByTestId('files-row-open')) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('keeps rendering even when the /files endpoint errors out', async () => {
    setupAPI({ filesError: true });
    renderPanel();
    // The panel chrome (title, close button) must stay visible so the
    // user can dismiss the side panel after a transient failure.
    expect(await screen.findByText('Files')).toBeTruthy();
  });

  it('passes parentID/parentType/messageID to the attachment fetch so signed-URL auth keeps working', async () => {
    setupAPI({
      files: [{ attachmentID: 'a-9', messageID: 'm-9', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' }],
      attachments: { 'a-9': { id: 'a-9', filename: 'x.txt', contentType: 'text/plain', size: 1, url: 'https://cdn/x.txt' } },
    });
    renderPanel({ channelId: 'ch-9' });
    await waitFor(() => expect(apiFetchMock.mock.calls.length).toBeGreaterThan(1));
    const attCall = apiFetchMock.mock.calls.find((c) => String(c[0]).includes('/attachments/a-9'))?.[0] as string;
    expect(attCall).toContain('parentID=ch-9');
    expect(attCall).toContain('parentType=channel');
    expect(attCall).toContain('messageID=m-9');
  });
});
