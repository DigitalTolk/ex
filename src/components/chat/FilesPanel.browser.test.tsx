import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FilesPanel } from './FilesPanel';

// Browser tests for the side-panel file list. These exercise the
// FULL flow: list endpoint → per-attachment metadata → row render —
// because skipping the data path is exactly how the "files panel is
// blank for everyone" bug shipped to prod.

const apiFetchMock = vi.fn();

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

interface FileEntryShape {
  attachmentID: string;
  messageID: string;
  authorID: string;
  createdAt: string;
}
interface AttachmentShape {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url?: string;
  downloadURL?: string;
  squareThumbnailURL?: string;
  thumbnailURL?: string;
}

function setupRoutes(opts: {
  files?: FileEntryShape[];
  attachments?: Record<string, AttachmentShape>;
  filesError?: boolean;
}) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string) => {
    if (typeof url !== 'string') return Promise.resolve(null);
    if (url.endsWith('/files')) {
      if (opts.filesError) return Promise.reject(new Error('boom'));
      return Promise.resolve(opts.files ?? []);
    }
    const idMatch = url.match(/\/attachments\/([^?]+)/);
    if (idMatch) {
      const id = idMatch[1];
      const att = opts.attachments?.[id];
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

describe('FilesPanel browser behaviour', () => {
  it('renders the side-panel header and close button', async () => {
    setupRoutes({});
    const screen = await renderPanel();
    await expect.element(screen.getByText('Files', { exact: true })).toBeVisible();
    expect(document.querySelector('button[aria-label*="lose"]')).not.toBeNull();
  });

  it('shows the empty-state copy when the API returns zero files', async () => {
    setupRoutes({ files: [] });
    const screen = await renderPanel();
    await expect.element(screen.getByTestId('files-empty')).toBeVisible();
  });

  it('hits /api/v1/channels/:id/files for a channel scope', async () => {
    setupRoutes({ files: [] });
    await renderPanel({ channelId: 'ch-99' });
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).toHaveBeenCalled();
    const firstCall = apiFetchMock.mock.calls[0][0] as string;
    expect(firstCall).toBe('/api/v1/channels/ch-99/files');
  });

  it('hits /api/v1/conversations/:id/files for a conversation scope', async () => {
    setupRoutes({ files: [] });
    await renderPanel({ channelId: undefined, conversationId: 'cv-7' });
    await new Promise((r) => setTimeout(r, 200));
    const firstCall = apiFetchMock.mock.calls[0][0] as string;
    expect(firstCall).toBe('/api/v1/conversations/cv-7/files');
  });

  it('renders a file row per FileEntry with author name + size + filename', async () => {
    setupRoutes({
      files: [
        { attachmentID: 'a-1', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' },
      ],
      attachments: {
        'a-1': { id: 'a-1', filename: 'spec.pdf', contentType: 'application/pdf', size: 12345, url: 'https://cdn/spec.pdf' },
      },
    });
    const screen = await renderPanel();
    await expect.element(screen.getByText('spec.pdf')).toBeVisible();
    await expect.element(screen.getByText(/Alice/)).toBeVisible();
    // formatBytes(12345) → "12.1 KB"
    await expect.element(screen.getByText(/KB/)).toBeVisible();
    const rows = document.querySelectorAll('[data-testid="files-row"]');
    expect(rows.length).toBe(1);
  });

  it('renders a thumbnail when the attachment is an image with a squareThumbnailURL', async () => {
    setupRoutes({
      files: [
        { attachmentID: 'a-img', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' },
      ],
      attachments: {
        'a-img': {
          id: 'a-img', filename: 'cat.png', contentType: 'image/png', size: 5000,
          url: 'https://cdn/cat.png', squareThumbnailURL: 'https://cdn/cat-thumb.png',
        },
      },
    });
    await renderPanel();
    // wait for both file-list query and per-attachment query to land
    const thumb = await waitFor(() => document.querySelector('[data-testid="files-row-thumb"]') as HTMLImageElement | null);
    expect(thumb).not.toBeNull();
    expect(thumb!.src).toContain('cat-thumb.png');
  });

  it('opens the image lightbox when an openable row is clicked', async () => {
    setupRoutes({
      files: [
        { attachmentID: 'a-img', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' },
      ],
      attachments: {
        'a-img': {
          id: 'a-img', filename: 'cat.png', contentType: 'image/png', size: 5000,
          url: 'https://cdn/cat.png', squareThumbnailURL: 'https://cdn/cat-thumb.png',
        },
      },
    });
    await renderPanel();
    const openBtn = await waitFor(() => {
      const btn = document.querySelector('[data-testid="files-row-open"]') as HTMLButtonElement | null;
      return btn && !btn.disabled ? btn : null;
    });
    expect(openBtn).not.toBeNull();
    openBtn!.click();
    await waitFor(() => document.querySelector('[data-testid="image-lightbox"]'));
    expect(document.querySelector('[data-testid="image-lightbox"]')).not.toBeNull();
  });

  it('falls back to the generic file icon when no thumbnail / non-image', async () => {
    setupRoutes({
      files: [
        { attachmentID: 'a-doc', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' },
      ],
      attachments: {
        'a-doc': { id: 'a-doc', filename: 'spec.pdf', contentType: 'application/pdf', size: 1, url: 'https://cdn/spec.pdf' },
      },
    });
    await renderPanel();
    await waitFor(() => document.querySelector('[data-testid="files-row-icon"]'));
    expect(document.querySelector('[data-testid="files-row-thumb"]')).toBeNull();
  });

  it('uses "Unknown" for an authorID that is not in the userMap', async () => {
    setupRoutes({
      files: [
        { attachmentID: 'a-2', messageID: 'm-2', authorID: 'u-MIA', createdAt: '2026-05-01T12:00:00Z' },
      ],
      attachments: {
        'a-2': { id: 'a-2', filename: 'mystery.txt', contentType: 'text/plain', size: 10, url: 'https://cdn/x.txt' },
      },
    });
    const screen = await renderPanel({ userMap: {} });
    await expect.element(screen.getByText(/Unknown/)).toBeVisible();
  });

  it('renders a download link wired to a.downloadURL with the original filename', async () => {
    setupRoutes({
      files: [
        { attachmentID: 'a-dl', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' },
      ],
      attachments: {
        'a-dl': {
          id: 'a-dl', filename: 'plan.txt', contentType: 'text/plain', size: 1,
          url: 'https://cdn/signed-view-link',
          downloadURL: 'https://cdn/signed-download-link',
        },
      },
    });
    await renderPanel();
    const link = await waitFor(() => document.querySelector('a[data-testid="files-row-download"]') as HTMLAnchorElement | null);
    expect(link).not.toBeNull();
    expect(link!.href).toContain('signed-download-link');
    expect(link!.getAttribute('download')).toBe('plan.txt');
  });

  it('does not render a download link until the attachment has resolved (url is set)', async () => {
    // FileEntry is present, but the per-attachment fetch returns no
    // attachment (e.g. 404 / scrubbed). The row still renders with the
    // placeholder filename, but the download link must not be wired up
    // to an undefined URL.
    setupRoutes({
      files: [
        { attachmentID: 'a-missing', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' },
      ],
      // No attachments map entry → attachment fetch rejects.
    });
    await renderPanel();
    await new Promise((r) => setTimeout(r, 200));
    // Row should exist…
    expect(document.querySelectorAll('[data-testid="files-row"]').length).toBe(1);
    // …but no download link until the metadata resolves.
    expect(document.querySelector('[data-testid="files-row-download"]')).toBeNull();
  });

  it('disables the open button until the attachment metadata has loaded', async () => {
    setupRoutes({
      files: [
        { attachmentID: 'a-loading', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z' },
      ],
      attachments: {}, // metadata not yet known
    });
    await renderPanel();
    await new Promise((r) => setTimeout(r, 200));
    const openBtn = document.querySelector('[data-testid="files-row-open"]') as HTMLButtonElement;
    expect(openBtn).not.toBeNull();
    expect(openBtn.disabled).toBe(true);
  });

  it('does not fetch /files when neither channelId nor conversationId is set', async () => {
    setupRoutes({});
    await renderPanel({ channelId: undefined, conversationId: undefined });
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

async function waitFor<T>(fn: () => T | null, timeout = 800): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}
