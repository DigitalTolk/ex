import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Attachment } from '@/types';

const useAttachmentsBatchMock = vi.fn();
vi.mock('@/hooks/useAttachments', () => ({
  useAttachmentsBatch: (ids: string[]) => useAttachmentsBatchMock(ids),
}));

import { MessageAttachments } from '@/components/chat/MessageAttachments';

const baseProps = {
  authorName: 'Alice',
  postedAt: '2026-04-26T10:30:00Z',
};

beforeEach(() => {
  useAttachmentsBatchMock.mockReset();
});

afterEach(() => {
  document.body.removeAttribute('style');
});

describe('MessageAttachments', () => {
  it('returns null when ids list is empty (renders nothing)', () => {
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), isLoading: false });
    const { container } = render(<MessageAttachments {...baseProps} ids={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an image attachment as a click-to-open thumbnail with <img>', () => {
    const att: Attachment = {
      id: 'a-1',
      filename: 'cat.png',
      contentType: 'image/png',
      size: 12345,
      url: 'https://cdn/cat.png',
      thumbnailURL: 'https://cdn/cat-thumb.webp',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-1', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-1']} />);
    const button = screen.getByLabelText('Open image cat.png');
    expect(button.tagName).toBe('BUTTON');
    expect(screen.getByAltText('cat.png')).toHaveAttribute('src', 'https://cdn/cat-thumb.webp');
  });

  it('renders a GIF from the original file so it animates (not the static thumbnail)', () => {
    const att: Attachment = {
      id: 'gif-1',
      filename: 'party.gif',
      contentType: 'image/gif',
      size: 200000,
      url: 'https://cdn/party.gif',
      thumbnailURL: 'https://cdn/party-thumb.webp',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['gif-1', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['gif-1']} />);
    // The animated original, not the static thumbnail frame.
    expect(screen.getByAltText('party.gif')).toHaveAttribute('src', 'https://cdn/party.gif');
  });

  it('keeps single-image thumbnails inside the mobile message column', () => {
    const att: Attachment = {
      id: 'a-mobile-img',
      filename: 'mobile.png',
      contentType: 'image/png',
      size: 12345,
      url: 'https://cdn/mobile.png',
      thumbnailURL: 'https://cdn/mobile-thumb.webp',
      width: 1600,
      height: 1200,
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-mobile-img', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-mobile-img']} />);

    expect(screen.getByLabelText('Open image mobile.png')).toHaveClass('max-md:max-w-full');
    expect(screen.getByAltText('mobile.png')).toHaveClass('max-w-full');
  });

  it('uses rendered thumbnail dimensions in image width and height attributes', () => {
    const att: Attachment = {
      id: 'wide-1',
      filename: 'wide.png',
      contentType: 'image/png',
      size: 12345,
      url: 'https://cdn/wide.png',
      thumbnailURL: 'https://cdn/wide-thumb.webp',
      width: 4000,
      height: 3000,
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['wide-1', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['wide-1']} />);
    const img = screen.getByAltText('wide.png');
    expect(img).toHaveAttribute('width', '320');
    expect(img).toHaveAttribute('height', '240');
  });

  it('caps tall image thumbnails by rendered height', () => {
    const att: Attachment = {
      id: 'tall-1',
      filename: 'tall.png',
      contentType: 'image/png',
      size: 12345,
      url: 'https://cdn/tall.png',
      thumbnailURL: 'https://cdn/tall-thumb.webp',
      width: 1000,
      height: 4000,
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['tall-1', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['tall-1']} />);
    const img = screen.getByAltText('tall.png');
    expect(img).toHaveAttribute('width', '72');
    expect(img).toHaveAttribute('height', '288');
  });

  it('attachment-box shows a small <img> thumbnail when the attachment is an image with a URL', () => {
    // Multi-attachment messages render the compact box for each row.
    // For image rows the box should show a small thumbnail in place of
    // the generic icon — same pattern as the FilesPanel sidebar — so
    // the user can tell images apart at a glance without opening the
    // lightbox.
    const att1: Attachment = {
      id: 'p-1',
      filename: 'one.png',
      contentType: 'image/png',
      size: 100,
      url: 'https://cdn/one.png',
      squareThumbnailURL: 'https://cdn/one-square.webp',
    };
    const att2: Attachment = {
      id: 'p-2',
      filename: 'two.pdf',
      contentType: 'application/pdf',
      size: 200,
      url: 'https://cdn/two.pdf',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map<string, Attachment>([
        ['p-1', att1],
        ['p-2', att2],
      ]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['p-1', 'p-2']} />);

    // Image row → real <img> thumbnail.
    const thumbs = screen.getAllByTestId('message-attachment-thumb');
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]).toHaveAttribute('src', 'https://cdn/one-square.webp');

    // Both rows present, but only the non-image keeps the generic
    // lucide icon (no thumbnail).
    const boxes = screen.getAllByTestId('message-attachment-box');
    expect(boxes).toHaveLength(2);
  });

  it('lets compact attachment boxes shrink to the mobile message width', () => {
    const att1: Attachment = {
      id: 'mobile-file-1',
      filename: 'one.pdf',
      contentType: 'application/pdf',
      size: 100,
      url: 'https://cdn/one.pdf',
    };
    const att2: Attachment = {
      id: 'mobile-file-2',
      filename: 'two.pdf',
      contentType: 'application/pdf',
      size: 200,
      url: 'https://cdn/two.pdf',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map<string, Attachment>([
        ['mobile-file-1', att1],
        ['mobile-file-2', att2],
      ]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['mobile-file-1', 'mobile-file-2']} />);

    for (const row of screen.getAllByTestId('message-attachment-box')) {
      expect(row.closest('.w-64')).toHaveClass('max-w-full', 'max-md:w-full');
    }
  });

  it('attachment-box and thumbnail buttons suppress click-focus outline but keep a keyboard ring', () => {
    const att: Attachment = {
      id: 'fok-1',
      filename: 'pic.png',
      contentType: 'image/png',
      size: 100,
      url: 'https://cdn/pic.png',
      thumbnailURL: 'https://cdn/pic-thumb.webp',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map<string, Attachment>([['fok-1', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['fok-1']} />);
    const thumb = screen.getByTestId('message-image-thumb');
    expect(thumb.className).toContain('outline-none');
    expect(thumb.className).toContain('focus-visible:ring-2');

    const att2: Attachment = {
      id: 'fok-2',
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      size: 100,
      url: 'https://cdn/doc.pdf',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map<string, Attachment>([
        ['fok-1', att],
        ['fok-2', att2],
      ]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['fok-1', 'fok-2']} />);
    for (const box of screen.getAllByTestId('message-attachment-box')) {
      expect(box.className).toContain('outline-none');
      expect(box.className).toContain('focus-visible:ring-2');
    }
  });

  it('renders a non-image as a clickable box with a separate download icon', () => {
    const att: Attachment = {
      id: 'a-2',
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      size: 4_500_000,
      url: 'https://cdn/doc.pdf',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-2', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-2']} />);
    // Box click target opens the lightbox; the download icon is its
    // own action with its own label.
    expect(screen.getByLabelText('Open doc.pdf')).toBeInTheDocument();
    expect(screen.getByLabelText('Download doc.pdf')).toBeInTheDocument();
    expect(screen.getByText('doc.pdf')).toBeInTheDocument();
    expect(screen.getByText(/MB/)).toBeInTheDocument();
  });

  it('download icon hits the forced-download URL when the backend supplies one', () => {
    // The presigned `url` opens inline (cross-origin <a download> is a
    // hint browsers ignore for S3). The backend hands us a separate
    // `downloadURL` whose response carries Content-Disposition: attachment;
    // download buttons must use that one so the click actually saves.
    const att: Attachment = {
      id: 'a-dl',
      filename: 'report.pdf',
      contentType: 'application/pdf',
      size: 1000,
      url: 'https://cdn/report.pdf',
      downloadURL: 'https://cdn/report.pdf?response-content-disposition=attachment',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-dl', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-dl']} />);
    const dl = screen.getByTestId('message-attachment-download');
    expect(dl).toHaveAttribute('href', att.downloadURL);
  });

  it('download icon falls back to the inline URL when no downloadURL is available', () => {
    const att: Attachment = {
      id: 'a-fb',
      filename: 'legacy.bin',
      contentType: 'application/octet-stream',
      size: 1000,
      url: 'https://cdn/legacy.bin',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-fb', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-fb']} />);
    expect(screen.getByTestId('message-attachment-download')).toHaveAttribute(
      'href',
      'https://cdn/legacy.bin',
    );
  });

  it('lightbox download buttons also use the forced-download URL', () => {
    const att: Attachment = {
      id: 'a-lb',
      filename: 'pic.png',
      contentType: 'image/png',
      size: 1000,
      url: 'https://cdn/pic.png',
      thumbnailURL: 'https://cdn/pic-thumb.webp',
      downloadURL: 'https://cdn/pic.png?response-content-disposition=attachment',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-lb', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-lb']} />);
    fireEvent.click(screen.getByLabelText('Open image pic.png'));
    expect(screen.getByTestId('image-lightbox-download')).toHaveAttribute(
      'href',
      att.downloadURL,
    );
    expect(screen.getByTestId('image-lightbox-toolbar')).toHaveClass('top-11', 'max-md:top-0');
    expect(screen.getByTestId('image-lightbox')).toHaveClass('pt-[calc(2.75rem+1.5rem)]');
  });

  it('shows a "Loading…" skeleton while the batch is in flight', () => {
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), isLoading: true });
    render(<MessageAttachments {...baseProps} ids={['a-3']} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows the "Attachment unavailable" skeleton when the batch has resolved without the id', () => {
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), isLoading: false });
    render(<MessageAttachments {...baseProps} ids={['a-missing']} />);
    expect(screen.getByText('Attachment unavailable')).toBeInTheDocument();
  });

  it('renders a single image without a URL as a (disabled) attachment box', () => {
    // Edge case: image content type but no presigned URL — without a
    // URL we can't open it, so the row falls back to the box layout
    // with the open button disabled.
    const att: Attachment = {
      id: 'a-4',
      filename: 'noimg.png',
      contentType: 'image/png',
      size: 100,
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-4', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-4']} />);
    expect(screen.getByLabelText('Open noimg.png')).toBeInTheDocument();
  });

  it('clicking an image opens the lightbox with author + parent + timestamp', () => {
    const att: Attachment = {
      id: 'a-5',
      filename: 'pic.png',
      contentType: 'image/png',
      size: 1000,
      url: 'https://cdn/pic.png',
      thumbnailURL: 'https://cdn/pic-thumb.webp',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-5', att]]),
      isLoading: false,
    });
    render(
      <MessageAttachments
        {...baseProps}
        ids={['a-5']}
        postedIn="~general"
      />,
    );
    fireEvent.click(screen.getByLabelText('Open image pic.png'));
    const lightbox = screen.getByTestId('image-lightbox');
    expect(lightbox).toBeInTheDocument();
    expect(lightbox).toHaveClass('max-md:pt-[calc(env(safe-area-inset-top)+4.5rem)]');
    expect(lightbox.textContent).toContain('Alice');
    expect(lightbox.textContent).toContain('~general');
    const image = screen.getByTestId('image-lightbox-image');
    expect(image).toHaveAttribute('src', 'https://cdn/pic.png');
    expect(image).toHaveClass('max-h-full', 'max-w-full');
    expect(screen.getByTestId('image-lightbox-zoom-stage')).toHaveClass('touch-none', 'overscroll-contain');
  });

  it('Escape closes the lightbox', () => {
    const att: Attachment = {
      id: 'a-6',
      filename: 'p.png',
      contentType: 'image/png',
      size: 100,
      url: 'https://cdn/p.png',
      thumbnailURL: 'https://cdn/p-thumb.webp',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-6', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-6']} />);
    fireEvent.click(screen.getByLabelText('Open image p.png'));
    expect(screen.getByTestId('image-lightbox')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
  });

  it('tapping the lightbox image does not close the lightbox so it can be zoomed', () => {
    const att: Attachment = {
      id: 'a-tap-close',
      filename: 'tap.png',
      contentType: 'image/png',
      size: 100,
      url: 'https://cdn/tap.png',
      thumbnailURL: 'https://cdn/tap-thumb.webp',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-tap-close', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-tap-close']} />);

    fireEvent.click(screen.getByLabelText('Open image tap.png'));
    fireEvent.click(screen.getByTestId('image-lightbox-image'));

    expect(screen.getByTestId('image-lightbox')).toBeInTheDocument();
  });

  it('zooms the lightbox image without relying on page zoom', () => {
    const att: Attachment = {
      id: 'a-zoom',
      filename: 'zoom.png',
      contentType: 'image/png',
      size: 100,
      url: 'https://cdn/zoom.png',
      thumbnailURL: 'https://cdn/zoom-thumb.webp',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-zoom', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-zoom']} />);

    fireEvent.click(screen.getByLabelText('Open image zoom.png'));
    const image = screen.getByTestId('image-lightbox-image');
    expect(image).toHaveStyle({ transform: 'translate(0px, 0px) scale(1)' });

    fireEvent.click(screen.getByTestId('image-lightbox-zoom-in'));
    expect(image).toHaveStyle({ transform: 'translate(0px, 0px) scale(1.8)' });

    fireEvent.click(screen.getByTestId('image-lightbox-zoom-out'));
    expect(image).toHaveStyle({ transform: 'translate(0px, 0px) scale(1.1)' });
  });

  it('pans a zoomed lightbox image on touch-style pointer drag', () => {
    const att: Attachment = {
      id: 'a-pan',
      filename: 'pan.png',
      contentType: 'image/png',
      size: 100,
      url: 'https://cdn/pan.png',
      thumbnailURL: 'https://cdn/pan-thumb.webp',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-pan', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-pan']} />);

    fireEvent.click(screen.getByLabelText('Open image pan.png'));
    const image = screen.getByTestId('image-lightbox-image');
    const stage = screen.getByTestId('image-lightbox-zoom-stage');
    fireEvent.click(screen.getByTestId('image-lightbox-zoom-in'));

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 120, clientY: 140, pointerType: 'touch' });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 152, clientY: 118, pointerType: 'touch' });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 152, clientY: 118, pointerType: 'touch' });

    expect(image).toHaveStyle({ transform: 'translate(32px, -22px) scale(1.8)' });
    expect(image).toHaveAttribute('data-pan-x', '32');
    expect(image).toHaveAttribute('data-pan-y', '-22');
  });

  it('Escape blurs the active element so the attachment trigger does not pick up a focus-visible ring after closing', () => {
    // Regression: pressing Esc to close the lightbox is a keyboard
    // interaction, which flips the browser's :focus-visible heuristic
    // on. The attachment-trigger button (still focused after the
    // lightbox unmounts) would then sit highlighted with the keyboard
    // focus ring even though the user just closed a modal. Blur on
    // close so the trigger drops focus entirely.
    const att: Attachment = {
      id: 'a-blur',
      filename: 'pic.png',
      contentType: 'image/png',
      size: 100,
      url: 'https://cdn/pic.png',
      thumbnailURL: 'https://cdn/pic-thumb.webp',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-blur', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-blur']} />);
    const trigger = screen.getByLabelText('Open image pic.png');
    fireEvent.click(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).not.toBe(trigger);
  });

  it('clicking the X button closes the lightbox', () => {
    const att: Attachment = {
      id: 'a-7',
      filename: 'p.png',
      contentType: 'image/png',
      size: 100,
      url: 'https://cdn/p.png',
      thumbnailURL: 'https://cdn/p-thumb.webp',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-7', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-7']} />);
    fireEvent.click(screen.getByLabelText('Open image p.png'));
    fireEvent.click(screen.getByTestId('image-lightbox-close'));
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
  });

  it('restores document scroll state after the lightbox closes', () => {
    const att: Attachment = {
      id: 'a-scroll-lock',
      filename: 'scroll.png',
      contentType: 'image/png',
      size: 100,
      url: 'https://cdn/scroll.png',
      thumbnailURL: 'https://cdn/scroll-thumb.webp',
    };
    document.body.style.overflow = 'auto';
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-scroll-lock', att]]),
      isLoading: false,
    });
    render(<MessageAttachments {...baseProps} ids={['a-scroll-lock']} />);

    fireEvent.click(screen.getByLabelText('Open image scroll.png'));
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.touchAction).toBe('');
    expect(document.body.style.overscrollBehavior).toBe('');

    fireEvent.click(screen.getByTestId('image-lightbox-close'));

    expect(document.body.style.overflow).toBe('auto');
    expect(document.body.style.touchAction).toBe('');
    expect(document.body.style.overscrollBehavior).toBe('');
  });

  function multiImageMap(): Map<string, Attachment> {
    return new Map<string, Attachment>([
      ['a', { id: 'a', filename: 'a.png', contentType: 'image/png', size: 1, url: 'https://cdn/a.png' }],
      ['b', { id: 'b', filename: 'b.png', contentType: 'image/png', size: 1, url: 'https://cdn/b.png' }],
      ['c', { id: 'c', filename: 'c.png', contentType: 'image/png', size: 1, url: 'https://cdn/c.png' }],
    ]);
  }

  it('ArrowRight cycles to the next image in the same message', () => {
    useAttachmentsBatchMock.mockReturnValue({ map: multiImageMap(), isLoading: false });
    render(<MessageAttachments {...baseProps} ids={['a', 'b', 'c']} />);
    fireEvent.click(screen.getByLabelText('Open a.png'));
    expect(screen.getByTestId('image-lightbox-image')).toHaveAttribute('src', 'https://cdn/a.png');

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByTestId('image-lightbox-image')).toHaveAttribute('src', 'https://cdn/b.png');

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByTestId('image-lightbox-image')).toHaveAttribute('src', 'https://cdn/c.png');

    // Wrap around — past the last image, jump back to the first.
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByTestId('image-lightbox-image')).toHaveAttribute('src', 'https://cdn/a.png');
  });

  it('ArrowLeft from the first image wraps to the last', () => {
    useAttachmentsBatchMock.mockReturnValue({ map: multiImageMap(), isLoading: false });
    render(<MessageAttachments {...baseProps} ids={['a', 'b', 'c']} />);
    fireEvent.click(screen.getByLabelText('Open a.png'));
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(screen.getByTestId('image-lightbox-image')).toHaveAttribute('src', 'https://cdn/c.png');
  });

  it('chevron buttons step through images', () => {
    useAttachmentsBatchMock.mockReturnValue({ map: multiImageMap(), isLoading: false });
    render(<MessageAttachments {...baseProps} ids={['a', 'b', 'c']} />);
    fireEvent.click(screen.getByLabelText('Open a.png'));
    fireEvent.click(screen.getByTestId('image-lightbox-next'));
    expect(screen.getByTestId('image-lightbox-image')).toHaveAttribute('src', 'https://cdn/b.png');
    fireEvent.click(screen.getByTestId('image-lightbox-prev'));
    expect(screen.getByTestId('image-lightbox-image')).toHaveAttribute('src', 'https://cdn/a.png');
  });

  it('hides chevrons and ignores arrow keys when there is only one image', () => {
    const single = new Map<string, Attachment>([
      [
        'x',
        {
          id: 'x',
          filename: 'only.png',
          contentType: 'image/png',
          size: 1,
          url: 'https://cdn/only.png',
          thumbnailURL: 'https://cdn/only-thumb.webp',
        },
      ],
    ]);
    useAttachmentsBatchMock.mockReturnValue({ map: single, isLoading: false });
    render(<MessageAttachments {...baseProps} ids={['x']} />);
    fireEvent.click(screen.getByLabelText('Open image only.png'));
    expect(screen.queryByTestId('image-lightbox-prev')).toBeNull();
    expect(screen.queryByTestId('image-lightbox-next')).toBeNull();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByTestId('image-lightbox-image')).toHaveAttribute('src', 'https://cdn/only.png');
  });
});
