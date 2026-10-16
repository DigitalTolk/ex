import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Attachment } from '@/types';
import { HTML_PREVIEW_MAX_BYTES } from '@/lib/html-attachment';

// The Preview action on message attachment rows: offered only for HTML files
// small enough to preview, and nothing is fetched or rendered until clicked.

const batchMock = vi.fn();
vi.mock('@/hooks/useAttachments', () => ({
  useAttachmentsBatch: (...args: unknown[]) => batchMock(...args),
}));
vi.mock('@/hooks/useAttachmentLightbox', () => ({
  useAttachmentLightbox: () => ({ open: vi.fn(), lightbox: null }),
}));

import { MessageAttachments } from './MessageAttachments';

function att(id: string, over: Partial<Attachment> = {}): Attachment {
  return {
    id,
    filename: `${id}.html`,
    contentType: 'text/html; charset=utf-8',
    size: 4096,
    url: `/api/v1/media/tok-${id}/${id}.html`,
    downloadURL: `/api/v1/media/tok-${id}/${id}.html?download=1`,
    ...over,
  } as Attachment;
}

function show(...atts: Attachment[]) {
  batchMock.mockReturnValue({ map: new Map(atts.map((a) => [a.id, a])), isLoading: false });
  return render(
    <MessageAttachments ids={atts.map((a) => a.id)} messageID="m1" authorName="Alice" postedAt="2026-01-01T00:00:00Z" />,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  batchMock.mockReset();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('<h1>Mockup</h1>') });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HTML attachment Preview action', () => {
  it('sits next to the download link of an HTML attachment', () => {
    show(att('mockup'));
    const preview = screen.getByRole('button', { name: 'Preview mockup.html' });
    const download = screen.getByRole('link', { name: 'Download mockup.html' });
    expect(preview.nextElementSibling).toBe(download);
  });

  it('is offered for .html/.htm by extension too, and only for HTML rows', () => {
    show(
      att('legacy', { filename: 'legacy.htm', contentType: 'application/octet-stream' }),
      att('report', { filename: 'report.pdf', contentType: 'application/pdf' }),
    );
    expect(screen.getByRole('button', { name: 'Preview legacy.htm' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview report.pdf' })).toBeNull();
    expect(screen.getAllByTestId('html-preview-open')).toHaveLength(1);
    // Both still download.
    expect(screen.getAllByTestId('message-attachment-download')).toHaveLength(2);
  });

  it('is download-only past 2 MB', () => {
    show(att('huge', { size: HTML_PREVIEW_MAX_BYTES + 1 }));
    expect(screen.queryByTestId('html-preview-open')).toBeNull();
    expect(screen.getByTestId('message-attachment-download')).toBeInTheDocument();
  });

  it('is not offered before the file URL resolves', () => {
    show(att('pending', { url: undefined }));
    expect(screen.queryByTestId('html-preview-open')).toBeNull();
  });

  it('fetches and renders nothing until clicked, then opens the preview panel', async () => {
    show(att('mockup'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Preview mockup.html' }));
    // The panel is a lazy chunk: the first open waits for its import.
    const dialog = await screen.findByRole('dialog', {}, { timeout: 10000 });
    expect(dialog).toHaveTextContent('mockup.html');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/media/tok-mockup/mockup.html', expect.anything());
    const frame = await screen.findByTestId('html-preview-frame');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.querySelector('iframe')).toBeNull();
  });
});
