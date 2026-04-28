import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { FilesPanel } from '@/components/chat/FilesPanel';

function renderPanel(
  props: { channelId?: string; conversationId?: string; postedIn?: string } = {
    channelId: 'ch-1',
  },
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FilesPanel
        channelId={props.channelId}
        conversationId={props.conversationId}
        onClose={vi.fn()}
        userMap={{
          'u-1': { displayName: 'Alice' },
        }}
        postedIn={props.postedIn}
      />
    </QueryClientProvider>,
  );
}

describe('FilesPanel', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('renders an empty state when no files have been shared', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/files')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('files-empty')).toBeInTheDocument());
  });

  it('renders one row per file with author + filename', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/files')) {
        return Promise.resolve([
          { attachmentID: 'a-1', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-04-26T10:00:00Z' },
        ]);
      }
      if (path.includes('/attachments?ids=')) {
        return Promise.resolve([
          {
            id: 'a-1',
            sha256: 'h',
            size: 1024,
            contentType: 'image/png',
            filename: 'shot.png',
            url: 'https://x/shot.png',
            createdBy: 'u-1',
            createdAt: '2026-04-26T10:00:00Z',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument());
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
  });

  it('hits the right path for conversations', async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve([]));
    renderPanel({ channelId: undefined, conversationId: 'conv-9' });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/conversations/conv-9/files');
  });

  it('renders the iconForAttachment glyph for non-image rows (matches message-row style)', async () => {
    // The 3-letter MIME slug ("appl", "imag", "pdf…") was unhelpful and
    // visually inconsistent with the icon used in message attachment
    // rows. The sidebar should now use the same iconForAttachment
    // glyph so the two surfaces look unified.
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/files')) {
        return Promise.resolve([
          { attachmentID: 'a-pdf', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-04-26T10:00:00Z' },
        ]);
      }
      if (path.includes('/attachments?ids=')) {
        return Promise.resolve([
          {
            id: 'a-pdf',
            sha256: 'h',
            size: 1024,
            contentType: 'application/pdf',
            filename: 'report.pdf',
            url: 'https://x/report.pdf',
            createdBy: 'u-1',
            createdAt: '2026-04-26T10:00:00Z',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPanel({ channelId: 'ch-1' });
    await waitFor(() => expect(screen.getByText('report.pdf')).toBeInTheDocument());

    const iconBox = screen.getByTestId('files-row-icon');
    expect(iconBox).toBeInTheDocument();
    // Lucide icons render as <svg>; the legacy 3-letter slug was plain
    // text, so finding any <svg> proves we switched to the glyph.
    expect(iconBox.querySelector('svg')).not.toBeNull();
    // The legacy 3-letter slug should be gone.
    expect(iconBox.textContent).toBe('');
    expect(screen.queryByTestId('files-row-thumb')).toBeNull();
  });

  it('renders an <img> thumbnail for image rows in the sidebar', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/files')) {
        return Promise.resolve([
          { attachmentID: 'a-img', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-04-26T10:00:00Z' },
        ]);
      }
      if (path.includes('/attachments?ids=')) {
        return Promise.resolve([
          {
            id: 'a-img',
            sha256: 'h',
            size: 1024,
            contentType: 'image/png',
            filename: 'pic.png',
            url: 'https://x/pic.png',
            createdBy: 'u-1',
            createdAt: '2026-04-26T10:00:00Z',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPanel({ channelId: 'ch-1' });
    await waitFor(() => expect(screen.getByText('pic.png')).toBeInTheDocument());
    expect(screen.getByTestId('files-row-thumb')).toHaveAttribute('src', 'https://x/pic.png');
    expect(screen.queryByTestId('files-row-icon')).toBeNull();
  });

  it('row is items-center so the download icon vertically centers next to the thumbnail', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/files')) {
        return Promise.resolve([
          { attachmentID: 'a-c', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-04-26T10:00:00Z' },
        ]);
      }
      if (path.includes('/attachments?ids=')) {
        return Promise.resolve([
          {
            id: 'a-c',
            sha256: 'h',
            size: 1024,
            contentType: 'application/pdf',
            filename: 'doc.pdf',
            url: 'https://x/doc.pdf',
            createdBy: 'u-1',
            createdAt: '2026-04-26T10:00:00Z',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPanel({ channelId: 'ch-1' });
    await waitFor(() => expect(screen.getByText('doc.pdf')).toBeInTheDocument());
    expect(screen.getByTestId('files-row').className).toContain('items-center');
  });

  it('open button suppresses the click-focus outline but keeps a keyboard ring', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/files')) {
        return Promise.resolve([
          { attachmentID: 'a-f', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-04-26T10:00:00Z' },
        ]);
      }
      if (path.includes('/attachments?ids=')) {
        return Promise.resolve([
          {
            id: 'a-f',
            sha256: 'h',
            size: 1024,
            contentType: 'application/pdf',
            filename: 'doc.pdf',
            url: 'https://x/doc.pdf',
            createdBy: 'u-1',
            createdAt: '2026-04-26T10:00:00Z',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPanel({ channelId: 'ch-1' });
    await waitFor(() => expect(screen.getByText('doc.pdf')).toBeInTheDocument());
    const cls = screen.getByTestId('files-row-open').className;
    expect(cls).toContain('outline-none');
    expect(cls).toContain('focus-visible:ring-2');
  });

  it('keeps the download icon reachable when the filename is extremely long', async () => {
    // Regression: the open <button> was flex-1 without min-w-0, so its
    // intrinsic min-content (thumbnail + the unbroken filename rendered
    // with white-space: nowrap) inflated past the row's width and shoved
    // the shrink-0 download <a> off the right edge of the panel.
    // jsdom can't measure real layout, so the test asserts the
    // structural invariant — the truncation chain (flex-1 + min-w-0) is
    // intact on the button, the download link stays shrink-0, and the
    // link is still in the DOM with the right href.
    const longName = 'a'.repeat(200) + '.pdf';
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/files')) {
        return Promise.resolve([
          { attachmentID: 'a-long', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-04-26T10:00:00Z' },
        ]);
      }
      if (path.includes('/attachments?ids=')) {
        return Promise.resolve([
          {
            id: 'a-long',
            sha256: 'h',
            size: 1024,
            contentType: 'application/pdf',
            filename: longName,
            url: 'https://x/long.pdf',
            downloadURL: 'https://x/long.pdf?response-content-disposition=attachment',
            createdBy: 'u-1',
            createdAt: '2026-04-26T10:00:00Z',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPanel({ channelId: 'ch-1' });
    await waitFor(() => expect(screen.getByText(longName)).toBeInTheDocument());

    const openBtn = screen.getByTestId('files-row-open');
    const cls = openBtn.className;
    expect(cls).toContain('flex-1');
    expect(cls).toContain('min-w-0');

    const dl = screen.getByTestId('files-row-download');
    expect(dl).toBeInTheDocument();
    expect(dl.className).toContain('shrink-0');
    expect(dl).toHaveAttribute(
      'href',
      'https://x/long.pdf?response-content-disposition=attachment',
    );
  });

  it('clicking a row opens the lightbox; download icon hits the forced-download URL', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/files')) {
        return Promise.resolve([
          { attachmentID: 'a-1', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-04-26T10:00:00Z' },
          { attachmentID: 'a-2', messageID: 'm-2', authorID: 'u-1', createdAt: '2026-04-26T11:00:00Z' },
        ]);
      }
      if (path.includes('/attachments?ids=')) {
        return Promise.resolve([
          {
            id: 'a-1',
            sha256: 'h1',
            size: 1024,
            contentType: 'image/png',
            filename: 'one.png',
            url: 'https://x/one.png',
            downloadURL: 'https://x/one.png?response-content-disposition=attachment',
            createdBy: 'u-1',
            createdAt: '2026-04-26T10:00:00Z',
          },
          {
            id: 'a-2',
            sha256: 'h2',
            size: 2048,
            contentType: 'image/png',
            filename: 'two.png',
            url: 'https://x/two.png',
            downloadURL: 'https://x/two.png?response-content-disposition=attachment',
            createdBy: 'u-1',
            createdAt: '2026-04-26T11:00:00Z',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPanel({ channelId: 'ch-1', postedIn: '~general' });
    await waitFor(() => expect(screen.getByText('one.png')).toBeInTheDocument());

    // Each row's download icon must point at the forced-download URL,
    // not the inline preview URL — otherwise <a download> is ignored
    // cross-origin and the file opens in a tab instead of saving.
    const dlLinks = screen.getAllByTestId('files-row-download');
    expect(dlLinks[0]).toHaveAttribute(
      'href',
      'https://x/one.png?response-content-disposition=attachment',
    );
    expect(dlLinks[1]).toHaveAttribute(
      'href',
      'https://x/two.png?response-content-disposition=attachment',
    );

    // Clicking the first row opens the lightbox seeded at index 0 with
    // the panel's full file set, so the user can chevron-step between
    // files without leaving the panel.
    fireEvent.click(screen.getAllByTestId('files-row-open')[1]);
    const lightbox = await screen.findByTestId('image-lightbox');
    expect(lightbox).toBeInTheDocument();
    expect(screen.getByTestId('image-lightbox-image')).toHaveAttribute(
      'src',
      'https://x/two.png',
    );
    // The lightbox's download button uses downloadURL, not the inline url.
    expect(screen.getByTestId('image-lightbox-download')).toHaveAttribute(
      'href',
      'https://x/two.png?response-content-disposition=attachment',
    );
    expect(lightbox.textContent).toContain('~general');
  });
});
