import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { FilesPanel } from './FilesPanel';

// Unit-test coverage for the files side panel. Catches the bug class
// where the panel mounts but never lists files — that shape was missing
// from the browser smoke test and let "files panel is blank" slip
// through. (jsdom has no IntersectionObserver, so every page loads.)

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

interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url?: string;
  downloadURL?: string;
  squareThumbnailURL?: string;
}
interface FileEntry {
  attachmentID: string;
  messageID: string;
  authorID: string;
  createdAt: string;
  attachment: Attachment;
}
interface FilePage {
  files: FileEntry[];
  nextCursor?: string;
}

function entry(attachment: Attachment, over: Partial<FileEntry> = {}): FileEntry {
  return { attachmentID: attachment.id, messageID: 'm-1', authorID: 'u-1', createdAt: '2026-05-01T12:00:00Z', attachment, ...over };
}

// pages maps a request's query string ('' for the first page, 'q=spec',
// 'cursor=c2', …) to its answer; anything else is an empty page.
function setupAPI(opts: { pages?: Record<string, FilePage | Promise<FilePage>>; files?: FileEntry[]; error?: boolean } = {}) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string) => {
    const [path, qs = ''] = url.split('?');
    if (!path.endsWith('/files')) return Promise.reject(new Error(`unexpected ${url}`));
    if (opts.error) return Promise.reject(new Error('boom'));
    if (opts.files && qs === '') return Promise.resolve({ files: opts.files });
    return Promise.resolve(opts.pages?.[qs] ?? { files: [] });
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

const spec: Attachment = { id: 'a-1', filename: 'spec.pdf', contentType: 'application/pdf', size: 12345, url: 'https://cdn/spec.pdf' };

describe('FilesPanel', () => {
  it('renders the panel header, close button and search field', async () => {
    setupAPI();
    renderPanel();
    expect(await screen.findByText('Files')).toBeTruthy();
    expect(document.querySelector('button[aria-label*="lose"]')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Search files' })).toBeTruthy();
  });

  it('shows the empty-state copy when no files are shared', async () => {
    setupAPI();
    renderPanel();
    expect((await screen.findByTestId('files-empty')).textContent).toBe('No files have been shared here yet.');
  });

  it('does not call /files when neither channelId nor conversationId is set', () => {
    setupAPI();
    renderPanel({ channelId: undefined, conversationId: undefined });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('calls /api/v1/channels/<id>/files for a channel scope', async () => {
    setupAPI();
    renderPanel({ channelId: 'ch-42' });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-42/files');
  });

  it('calls /api/v1/conversations/<id>/files for a conversation scope', async () => {
    setupAPI();
    renderPanel({ channelId: undefined, conversationId: 'cv-7' });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/conversations/cv-7/files');
  });

  it('renders one row per file with filename + author + size, from the one list request', async () => {
    setupAPI({ files: [entry(spec)] });
    renderPanel();
    expect(await screen.findByText('spec.pdf')).toBeTruthy();
    expect(screen.getByText(/Alice/)).toBeTruthy();
    expect(screen.getByText(/KB/)).toBeTruthy();
    expect(document.querySelectorAll('[data-testid="files-row"]').length).toBe(1);
    // No request per file.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders a thumbnail when the attachment is an image with a squareThumbnailURL', async () => {
    setupAPI({
      files: [entry({
        id: 'img-1', filename: 'cat.png', contentType: 'image/png', size: 5000,
        url: 'https://cdn/cat.png', squareThumbnailURL: 'https://cdn/cat-thumb.png',
      })],
    });
    renderPanel();
    const thumb = await screen.findByTestId('files-row-thumb') as HTMLImageElement;
    expect(thumb.src).toContain('cat-thumb.png');
  });

  it('falls back to the file-type icon for non-image attachments, even with a thumbnail', async () => {
    setupAPI({ files: [entry({ ...spec, squareThumbnailURL: 'https://cdn/page-1.png' })] });
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-testid="files-row-icon"]')).toBeTruthy());
    expect(document.querySelector('[data-testid="files-row-thumb"]')).toBeFalsy();
  });

  it('substitutes "Unknown" for an unknown authorID', async () => {
    setupAPI({ files: [entry({ id: 'a-1', filename: 'mystery.txt', contentType: 'text/plain', size: 1, url: 'https://cdn/x.txt' }, { authorID: 'u-MIA' })] });
    renderPanel({ userMap: {} });
    expect(await screen.findByText(/Unknown/)).toBeTruthy();
  });

  it('renders the download link using attachment.downloadURL when present', async () => {
    setupAPI({
      files: [entry({
        id: 'a-1', filename: 'plan.txt', contentType: 'text/plain', size: 1,
        url: 'https://cdn/signed-view', downloadURL: 'https://cdn/signed-download',
      })],
    });
    renderPanel();
    const link = (await screen.findByTestId('files-row-download')) as HTMLAnchorElement;
    expect(link.href).toContain('signed-download');
    expect(link.getAttribute('download')).toBe('plan.txt');
  });

  it('downloads from the view URL when there is no separate download URL', async () => {
    setupAPI({ files: [entry(spec)] });
    renderPanel();
    const link = (await screen.findByTestId('files-row-download')) as HTMLAnchorElement;
    expect(link.href).toBe('https://cdn/spec.pdf');
  });

  it('offers Preview beside Download for an HTML file, and only for it', async () => {
    setupAPI({
      files: [
        entry({ id: 'a-1', filename: 'mockup.html', contentType: 'text/html', size: 2048, url: '/api/v1/media/t1/mockup.html' }),
        entry({ id: 'a-2', filename: 'plan.txt', contentType: 'text/plain', size: 1, url: 'https://cdn/plan.txt' }, { messageID: 'm-2' }),
      ],
    });
    renderPanel();
    const preview = await screen.findByRole('button', { name: 'Preview mockup.html' });
    expect(preview.nextElementSibling).toHaveAttribute('data-testid', 'files-row-download');
    expect(screen.getAllByTestId('files-row-download')).toHaveLength(2);
    expect(screen.getAllByTestId('html-preview-open')).toHaveLength(1);
  });

  it('cannot open or download a file it has no URL for', async () => {
    setupAPI({ files: [entry({ id: 'a-1', filename: 'stuck.bin', contentType: 'application/octet-stream', size: 1 })] });
    renderPanel();
    const btn = (await screen.findByTestId('files-row-open')) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(document.querySelector('[data-testid="files-row-download"]')).toBeFalsy();
  });

  it('says the files could not be loaded, and keeps the panel usable, when /files fails', async () => {
    setupAPI({ error: true });
    renderPanel();
    expect((await screen.findByTestId('files-error')).textContent).toBe("Couldn't load files.");
    // The panel chrome (title, close button) must stay visible so the
    // user can dismiss the side panel after a transient failure.
    expect(screen.getByText('Files')).toBeTruthy();
    expect(screen.queryByTestId('files-empty')).toBeNull();
  });

  it('filters by name on the server as the user types', async () => {
    setupAPI({
      files: [entry(spec), entry({ id: 'a-2', filename: 'cat.png', contentType: 'image/png', size: 1 }, { messageID: 'm-2' })],
      pages: { 'q=spec': { files: [entry(spec)] } },
    });
    renderPanel();
    expect(await screen.findByText('cat.png')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search files' }), { target: { value: '  spec ' } });
    await waitFor(() => expect(screen.queryByText('cat.png')).toBeNull());
    expect(screen.getByText('spec.pdf')).toBeTruthy();
    expect(apiFetchMock.mock.calls.map((c) => c[0])).toContain('/api/v1/channels/ch-1/files?q=spec');
  });

  it('says when nothing matches the search', async () => {
    setupAPI({ files: [entry(spec)] });
    renderPanel();
    await screen.findByText('spec.pdf');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search files' }), { target: { value: 'nothing' } });
    expect((await screen.findByTestId('files-empty')).textContent).toBe('No matching files.');
  });

  it('loads the next page with the cursor the last page returned', async () => {
    let finishSecond!: (page: FilePage) => void;
    const second = new Promise<FilePage>((resolve) => { finishSecond = resolve; });
    setupAPI({
      pages: {
        '': { files: [entry(spec)], nextCursor: 'c2' },
        'cursor=c2': second,
      },
    });
    renderPanel();
    expect(await screen.findByText('spec.pdf')).toBeTruthy();
    expect(await screen.findByText('Loading more…')).toBeTruthy();
    finishSecond({ files: [entry({ id: 'a-2', filename: 'older.txt', contentType: 'text/plain', size: 1, url: 'https://cdn/o.txt' }, { messageID: 'm-2' })] });
    expect(await screen.findByText('older.txt')).toBeTruthy();
    expect(screen.queryByText('Loading more…')).toBeNull();
    expect(screen.getAllByTestId('files-row')).toHaveLength(2);
    expect(apiFetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/channels/ch-1/files',
      '/api/v1/channels/ch-1/files?cursor=c2',
    ]);
  });
});
