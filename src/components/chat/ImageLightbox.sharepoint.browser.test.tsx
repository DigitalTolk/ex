import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImageLightbox, type LightboxImage } from './ImageLightbox';

// A SharePoint file in the lightbox shows as it is, in the viewer whose
// address the server fetched as the viewer, with Edit (Office for the web)
// and Download (from SharePoint) beside it.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

// Stands in for the viewer's address: a test loads nothing from Microsoft.
const VIEWER = 'about:blank#viewer';
const EDIT = 'https://contoso.sharepoint.com/sites/team/_layouts/15/Doc.aspx?sourcedoc=%7Bu-1%7D&action=edit';
const DOWNLOAD = 'https://contoso.sharepoint.com/sites/team/_layouts/15/download.aspx?UniqueId=u-1';

const plan: LightboxImage = {
  url: 'https://contoso.sharepoint.com/sites/team/Plan.docx',
  downloadURL: DOWNLOAD,
  filename: 'Plan.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 2048,
  sharePoint: { parent: { channelId: 'ch-1' }, fileID: 'f-1', editURL: EDIT },
};

async function open(images: LightboxImage[], onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={qc}>
      <ImageLightbox open onClose={onClose} images={images} index={0} onIndexChange={vi.fn()} authorName="Ann" postedAt="2026-10-30T09:00:00Z" />
    </QueryClientProvider>,
  );
  return { screen, onClose };
}

const el = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ url: VIEWER });
});
afterEach(() => cleanup());

describe('ImageLightbox SharePoint files', () => {
  it('shows the file as it is, with Edit and Download', async () => {
    const { screen, onClose } = await open([plan]);
    const viewer = screen.getByTestId('sharepoint-preview');
    await expect.element(viewer).toHaveAttribute('src', VIEWER);
    await expect.element(viewer).toHaveAttribute('title', 'Plan.docx');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/sharepoint/preview?parentType=channel&parentID=ch-1&fileID=f-1');

    const edit = screen.getByTestId('image-lightbox-edit');
    await expect.element(edit).toHaveAttribute('href', EDIT);
    await expect.element(edit).toHaveAttribute('target', '_blank');
    await expect.element(edit).toHaveTextContent('Edit');
    // Downloads from SharePoint, in a new tab: the browser there holds the
    // Microsoft sign-in.
    const download = el('image-lightbox-download') as HTMLAnchorElement;
    expect(download.getAttribute('href')).toBe(DOWNLOAD);
    expect(download.getAttribute('target')).toBe('_blank');
    expect(download.hasAttribute('download')).toBe(false);
    // The viewer zooms itself.
    expect(el('image-lightbox-zoom-in')).toBeNull();

    // A click or a swipe over the viewer stays the viewer's.
    const stage = el('image-lightbox-sharepoint') as HTMLElement;
    stage.click();
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 200, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 600, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 600, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'touch', bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open behind Edit, which opens Office for the web in a new tab', async () => {
    const { screen, onClose } = await open([plan]);
    await expect.element(screen.getByTestId('image-lightbox-edit')).toBeVisible();
    const edit = el('image-lightbox-edit') as HTMLAnchorElement;
    // No new tab from a test.
    edit.addEventListener('click', (e) => e.preventDefault());
    edit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    await expect.element(screen.getByTestId('image-lightbox')).toBeVisible();
  });

  it('says it is loading until the address arrives', async () => {
    let answer!: (v: { url: string }) => void;
    apiFetchMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { screen } = await open([plan]);
    await expect.element(screen.getByText('Loading…')).toBeVisible();
    answer({ url: VIEWER });
    await expect.element(screen.getByTestId('sharepoint-preview')).toHaveAttribute('src', VIEWER);
  });

  it('falls back to the file card when there is no preview', async () => {
    apiFetchMock.mockRejectedValue(new Error('403'));
    const { screen } = await open([plan]);
    await expect.element(screen.getByTestId('image-lightbox-fileinfo')).toBeVisible();
    expect(el('sharepoint-preview')).toBeNull();
    expect(el('file-type-icon')?.getAttribute('data-kind')).toBe('document');
    const download = el('image-lightbox-file-download') as HTMLAnchorElement;
    expect(download.getAttribute('href')).toBe(DOWNLOAD);
    expect(download.getAttribute('target')).toBe('_blank');
  });

  it('shows any SharePoint file in its viewer, and offers Edit only where Office edits it', async () => {
    // A PDF and an image on SharePoint, in a conversation: neither the PDF
    // viewer nor the image stage, and nothing to edit.
    const pdf: LightboxImage = {
      ...plan,
      filename: 'Scan.pdf',
      contentType: 'application/pdf',
      downloadURL: undefined,
      sharePoint: { parent: { conversationId: 'dm-1' }, fileID: 'f-2' },
    };
    const { screen } = await open([pdf, { ...pdf, filename: 'photo.png', contentType: 'image/png' }]);
    await expect.element(screen.getByTestId('sharepoint-preview')).toHaveAttribute('src', VIEWER);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/sharepoint/preview?parentType=conversation&parentID=dm-1&fileID=f-2');
    expect(el('image-lightbox-pdf')).toBeNull();
    expect(el('image-lightbox-edit')).toBeNull();
    // Without its download address, it downloads from its SharePoint page.
    expect(el('image-lightbox-download')?.getAttribute('href')).toBe(plan.url);
  });

  for (const contentType of ['image/png', 'video/mp4']) {
    it(`never shows a SharePoint ${contentType} itself`, async () => {
      const { screen } = await open([{ ...plan, filename: 'clip', contentType }]);
      await expect.element(screen.getByTestId('sharepoint-preview')).toHaveAttribute('src', VIEWER);
      expect(el('image-lightbox-image')).toBeNull();
      expect(el('image-lightbox-video')).toBeNull();
    });
  }
});
