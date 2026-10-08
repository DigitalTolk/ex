import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-react';
import PdfPreview from './PdfPreview';
import { buildPdf, pdfObjectURL } from '@/test/pdf-fixture';

// pdf.js spins up a worker and parses the document off-thread; under the full
// suite's CPU saturation that takes well over expect.poll's 1s default.
const PDF_LOAD = { timeout: 15000 };

const urls: string[] = [];
function pdfURL(pages: number, linkToPage?: number): string {
  const url = pdfObjectURL(buildPdf({ pages, linkToPage }));
  urls.push(url);
  return url;
}

function Frame({ url }: { url: string }) {
  // The lightbox gives the viewer a definite box; mirror that here.
  return (
    <div style={{ width: 600, height: 500, maxWidth: '100vw' }}>
      <PdfPreview url={url} fallback={<p data-testid="pdf-fallback">fallback</p>} />
    </div>
  );
}

function renderedPages(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.react-pdf__Page'));
}

afterEach(async () => {
  await cleanup();
  while (urls.length) URL.revokeObjectURL(urls.pop()!);
});

describe('PdfPreview', () => {
  it('renders the pages of a PDF to canvases sized to the viewer', async () => {
    await render(<Frame url={pdfURL(2)} />);
    await expect.poll(() => document.querySelector('.react-pdf__Page canvas'), PDF_LOAD).not.toBeNull();
    const canvas = document.querySelector<HTMLCanvasElement>('.react-pdf__Page[data-page-number="1"] canvas')!;
    await expect.poll(() => canvas.getBoundingClientRect().width, PDF_LOAD).toBeGreaterThan(0);
    // Pages are fitted to the viewer's width (capped), never wider.
    const viewer = document.querySelector<HTMLElement>('[data-testid="pdf-preview"]')!;
    expect(canvas.getBoundingClientRect().width).toBeLessThanOrEqual(viewer.getBoundingClientRect().width);
    expect(document.querySelector('[data-testid="pdf-fallback"]')).toBeNull();
  });

  it('virtualizes long documents instead of rendering every page', async () => {
    await render(<Frame url={pdfURL(40)} />);
    await expect.poll(() => renderedPages().length, PDF_LOAD).toBeGreaterThan(0);
    // Only the pages near the viewport are mounted.
    expect(renderedPages().length).toBeLessThan(10);
    const scroller = document.querySelector<HTMLElement>('[data-testid="pdf-preview-pages"]')!;
    scroller.scrollTop = scroller.scrollHeight;
    await expect.poll(() => renderedPages().some((p) => p.dataset.pageNumber === '40'), PDF_LOAD).toBe(true);
    expect(renderedPages().some((p) => p.dataset.pageNumber === '1')).toBe(false);
  });

  it('follows internal links to the target page', async () => {
    await render(<Frame url={pdfURL(12, 10)} />);
    await expect.poll(() => document.querySelector('.annotationLayer a'), PDF_LOAD).not.toBeNull();
    document.querySelector<HTMLAnchorElement>('.annotationLayer a')!.click();
    await expect.poll(() => renderedPages().some((p) => p.dataset.pageNumber === '10'), PDF_LOAD).toBe(true);
    const scroller = document.querySelector<HTMLElement>('[data-testid="pdf-preview-pages"]')!;
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it('shows the fallback when the document cannot be loaded', async () => {
    // react-pdf reports the load failure through its dev-only warning().
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = URL.createObjectURL(new Blob(['not a pdf'], { type: 'application/pdf' }));
    urls.push(broken);
    await render(<Frame url={broken} />);
    await expect.poll(() => document.querySelector('[data-testid="pdf-fallback"]'), PDF_LOAD).not.toBeNull();
    expect(renderedPages()).toHaveLength(0);
    expect(warn.mock.calls.flat().join(' ')).toContain('Invalid PDF');
    warn.mockRestore();
  });
});
