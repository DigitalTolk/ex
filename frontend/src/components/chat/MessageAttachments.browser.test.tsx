import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { afterEach } from 'vitest';
import { MessageAttachments } from './MessageAttachments';
import type { Attachment } from '@/types';

// vitest-browser-react cleanup() doesn't await the async unmount, so on
// WebKit a prior render's <img> lingers and global selectors match it.
// Track each mount and await unmount() for a deterministic teardown.
const mounted: Array<{ unmount: () => Promise<void> }> = [];
async function mount(ui: React.ReactElement) {
  const result = await render(ui);
  mounted.push(result);
  return result;
}

// Browser coverage for the message attachment renderer — the single-image
// thumbnail path, the compact file rows + download link, and the
// loading/unavailable skeletons.

let batch: { map: Map<string, Attachment>; isLoading: boolean } = { map: new Map(), isLoading: false };
vi.mock('@/hooks/useAttachments', () => ({
  useAttachmentsBatch: () => batch,
}));

const openSpy = vi.fn();
vi.mock('@/hooks/useAttachmentLightbox', () => ({
  useAttachmentLightbox: () => ({ open: openSpy, lightbox: <div data-testid="lightbox" /> }),
}));

function att(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a-1',
    filename: 'file.bin',
    contentType: 'application/octet-stream',
    size: 1024,
    url: 'https://files/a-1',
    downloadURL: 'https://files/a-1?download=1',
    ...overrides,
  } as Attachment;
}

function mapOf(...atts: Attachment[]) {
  return new Map(atts.map((a) => [a.id, a]));
}

function base() {
  return { messageID: 'm-1', authorName: 'Alice', postedAt: '2026-05-01T10:00:00Z' };
}

afterEach(async () => {
  for (const m of mounted.splice(0)) await m.unmount();
  batch = { map: new Map(), isLoading: false };
  openSpy.mockClear();
});

describe('MessageAttachments browser', () => {
  it('renders nothing when there are no attachment ids', async () => {
    await mount(<MessageAttachments ids={[]} {...base()} />);
    expect(document.querySelector('[data-testid="lightbox"]')).toBeNull();
  });

  it('renders a single image as a big inline thumbnail with reserved dimensions', async () => {
    const image = att({ id: 'img', filename: 'pic.png', contentType: 'image/png', thumbnailURL: 'https://files/pic-thumb.png', squareThumbnailURL: 'https://files/pic-sq.png', width: 640, height: 480 });
    batch = { map: mapOf(image), isLoading: false };
    const screen = await mount(<MessageAttachments ids={['img']} {...base()} />);
    const thumb = document.querySelector('[data-testid="message-image-thumb"]') as HTMLElement;
    expect(thumb).not.toBeNull();
    const img = thumb.querySelector('img') as HTMLImageElement;
    // getThumbnailDimensions scaled the 640×480 down to the 320px cap.
    expect(Number(img.getAttribute('width'))).toBeGreaterThan(0);
    expect(Number(img.getAttribute('height'))).toBeGreaterThan(0);
    await screen.getByTestId('message-image-thumb').click();
    expect(openSpy).toHaveBeenCalledWith('img');
  });

  it('renders a GIF from its animated original, not the static thumbnail', async () => {
    const gif = att({ id: 'gif', filename: 'party.gif', contentType: 'image/gif', url: 'https://files/party.gif', thumbnailURL: 'https://files/party-thumb.png', squareThumbnailURL: 'https://files/party-sq.png' });
    batch = { map: mapOf(gif), isLoading: false };
    await mount(<MessageAttachments ids={['gif']} {...base()} />);
    const img = document.querySelector('[data-testid="message-image-thumb"] img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://files/party.gif');
  });

  it('falls back to the thumbnail for a GIF that has no original url', async () => {
    const gif = att({ id: 'gif2', filename: 'nourl.gif', contentType: 'image/gif', url: undefined, thumbnailURL: 'https://files/nourl-thumb.png', squareThumbnailURL: 'https://files/nourl-sq.png' });
    batch = { map: mapOf(gif), isLoading: false };
    await mount(<MessageAttachments ids={['gif2']} {...base()} />);
    const img = document.querySelector('[data-testid="message-image-thumb"] img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://files/nourl-thumb.png');
  });

  it('renders a single image without intrinsic dimensions (no width/height attrs)', async () => {
    const image = att({ id: 'img2', filename: 'pic.png', contentType: 'image/png', thumbnailURL: 'https://files/pic-thumb.png', squareThumbnailURL: 'https://files/pic-sq.png' });
    batch = { map: mapOf(image), isLoading: false };
    await mount(<MessageAttachments ids={['img2']} {...base()} />);
    const img = document.querySelector('[data-testid="message-image-thumb"] img') as HTMLImageElement;
    expect(img.getAttribute('width')).toBeNull();
  });

  it('renders multiple attachments as compact rows with image preview + download links', async () => {
    const image = att({ id: 'img3', filename: 'photo.jpg', contentType: 'image/jpeg', squareThumbnailURL: 'https://files/photo-sq.jpg' });
    const pdf = att({ id: 'doc', filename: 'report.pdf', contentType: 'application/pdf' });
    batch = { map: mapOf(image, pdf), isLoading: false };
    await mount(<MessageAttachments ids={['img3', 'doc']} {...base()} />);
    const boxes = document.querySelectorAll('[data-testid="message-attachment-box"]');
    expect(boxes.length).toBe(2);
    // The image row shows a thumbnail <img>; the pdf row shows an icon.
    expect(document.querySelector('[data-testid="message-attachment-box"] img')).not.toBeNull();
    // Each attachment with a url renders a download link.
    const downloads = document.querySelectorAll('[data-testid="message-attachment-download"]');
    expect(downloads.length).toBe(2);
    expect((downloads[0] as HTMLAnchorElement).getAttribute('href')).toContain('download=1');
  });

  it('shows a loading skeleton while attachment metadata is still fetching', async () => {
    batch = { map: new Map(), isLoading: true };
    const screen = await mount(<MessageAttachments ids={['pending']} {...base()} />);
    await expect.element(screen.getByText('Loading…')).toBeVisible();
  });

  it('shows an unavailable placeholder when metadata resolves but the row is missing', async () => {
    batch = { map: new Map(), isLoading: false };
    const screen = await mount(<MessageAttachments ids={['gone']} {...base()} />);
    await expect.element(screen.getByText('Attachment unavailable')).toBeVisible();
  });

  it('reports a content-height change once all attachments are resolved', async () => {
    const pdf = att({ id: 'doc2', filename: 'a.pdf', contentType: 'application/pdf' });
    batch = { map: mapOf(pdf), isLoading: false };
    const onContentHeightChange = vi.fn();
    await mount(<MessageAttachments ids={['doc2']} {...base()} onContentHeightChange={onContentHeightChange} />);
    await vi.waitFor(() => expect(onContentHeightChange).toHaveBeenCalled());
  });
});
