import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FilesPanel } from './FilesPanel';

// Browser tests for the side-panel file list: the full flow from the list
// endpoint to rendered rows (skipping the data path is exactly how the
// "files panel is blank for everyone" bug shipped to prod), plus what only a
// real browser shows — the next page loading as the list scrolls to its end.

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

interface AttachmentShape {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url?: string;
  downloadURL?: string;
  squareThumbnailURL?: string;
}
interface FilePage {
  files: { attachmentID: string; messageID: string; authorID: string; createdAt: string; attachment: AttachmentShape }[];
  nextCursor?: string;
}

function file(id: string, over: Partial<AttachmentShape> = {}) {
  return {
    attachmentID: id,
    messageID: `m-${id}`,
    authorID: 'u-1',
    createdAt: '2026-05-01T12:00:00Z',
    attachment: { id, filename: `${id}.pdf`, contentType: 'application/pdf', size: 12345, url: `https://cdn/${id}.pdf`, ...over },
  };
}

// pages maps a request's query string ('' for the first page) to its answer.
function setupRoutes(pages: Record<string, FilePage>) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string) => {
    const [, qs = ''] = url.split('?');
    return Promise.resolve(pages[qs] ?? { files: [] });
  });
}

const requested = () => apiFetchMock.mock.calls.map((c) => c[0] as string);

function renderPanel(props?: Partial<Parameters<typeof FilesPanel>[0]>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        {/* A rail-sized box, so a long list scrolls inside the panel. */}
        <div style={{ display: 'flex', height: 480 }}>
          <FilesPanel
            channelId="ch-1"
            onClose={vi.fn()}
            userMap={{ 'u-1': { displayName: 'Alice' } }}
            postedIn="~general"
            {...props}
          />
        </div>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('FilesPanel browser behaviour', () => {
  it('renders the header, the search field and a row per file from one request', async () => {
    setupRoutes({ '': { files: [file('spec')] } });
    const screen = await renderPanel();
    await expect.element(screen.getByText('Files', { exact: true })).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Search files' })).toBeVisible();
    await expect.element(screen.getByText('spec.pdf')).toBeVisible();
    await expect.element(screen.getByText(/Alice/)).toBeVisible();
    // formatBytes(12345) → "12.1 KB"
    await expect.element(screen.getByText(/KB/)).toBeVisible();
    expect(requested()).toEqual(['/api/v1/channels/ch-1/files']);
  });

  it('keeps the search glyph clear of the typed text', async () => {
    setupRoutes({});
    const screen = await renderPanel();
    const input = screen.getByRole('textbox', { name: 'Search files' });
    await expect.element(input).toBeVisible();
    const field = input.element() as HTMLInputElement;
    const glyph = field.parentElement!.querySelector('svg')!;
    const textStart = field.getBoundingClientRect().left + parseFloat(getComputedStyle(field).paddingLeft);
    expect(glyph.getBoundingClientRect().right).toBeLessThanOrEqual(textStart);
  });

  it('opens the image lightbox when an image row is clicked', async () => {
    setupRoutes({
      '': { files: [file('cat', { filename: 'cat.png', contentType: 'image/png', url: 'https://cdn/cat.png', squareThumbnailURL: 'https://cdn/cat-thumb.png' })] },
    });
    const screen = await renderPanel();
    await expect.element(screen.getByTestId('files-row-thumb')).toHaveAttribute('src', 'https://cdn/cat-thumb.png');
    await screen.getByRole('button', { name: 'Open cat.png' }).click();
    await expect.element(screen.getByTestId('image-lightbox')).toBeVisible();
  });

  it('loads the next page when the list is scrolled to its end', async () => {
    const first = Array.from({ length: 30 }, (_, i) => file(`f${String(i).padStart(2, '0')}`));
    setupRoutes({
      '': { files: first, nextCursor: 'c2' },
      'cursor=c2': { files: [file('older')] },
    });
    const screen = await renderPanel();
    await expect.element(screen.getByText('f00.pdf')).toBeVisible();
    // Thirty rows overflow the panel: the end of the list is out of view.
    expect(requested()).toEqual(['/api/v1/channels/ch-1/files']);

    const list = screen.getByTestId('files-list').element();
    list.parentElement!.scrollTop = list.parentElement!.scrollHeight;
    await expect.element(screen.getByText('older.pdf')).toBeInTheDocument();
    expect(requested()).toEqual(['/api/v1/channels/ch-1/files', '/api/v1/channels/ch-1/files?cursor=c2']);
  });

  it('keeps loading while a short page leaves the end of the list in view', async () => {
    setupRoutes({
      '': { files: [file('a')], nextCursor: 'c2' },
      'cursor=c2': { files: [file('b')] },
    });
    const screen = await renderPanel();
    await expect.element(screen.getByText('b.pdf')).toBeVisible();
    await expect.element(screen.getByText('a.pdf')).toBeVisible();
  });

  it('asks the server for matches as the user types', async () => {
    setupRoutes({
      '': { files: [file('spec'), file('cat', { filename: 'cat.png', contentType: 'image/png' })] },
      'q=cat': { files: [file('cat', { filename: 'cat.png', contentType: 'image/png' })] },
    });
    const screen = await renderPanel();
    await expect.element(screen.getByText('spec.pdf')).toBeVisible();
    await screen.getByRole('textbox', { name: 'Search files' }).fill('cat');
    await expect.element(screen.getByText('spec.pdf')).not.toBeInTheDocument();
    await expect.element(screen.getByText('cat.png')).toBeVisible();
    expect(requested()).toContain('/api/v1/channels/ch-1/files?q=cat');
  });
});
