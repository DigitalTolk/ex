import { useState } from 'react';
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

// A viewer whose zoom the test (or a pinch / Ctrl+wheel on it) changes, as
// the lightbox does.
function ZoomFrame({ url, initial = 1, onZoom }: { url: string; initial?: number; onZoom?: (zoom: number) => void }) {
  const [zoom, setZoom] = useState(initial);
  return (
    <div style={{ width: 600, height: 500, maxWidth: '100vw' }}>
      <button data-testid="zoom-2" onClick={() => setZoom(2)}>2×</button>
      <PdfPreview
        url={url}
        fallback={<p data-testid="pdf-fallback">fallback</p>}
        zoom={zoom}
        maxZoom={3}
        onZoomChange={(next) => {
          onZoom?.(next);
          setZoom(next);
        }}
      />
    </div>
  );
}

const pageWidth = (n: number) =>
  document.querySelector<HTMLCanvasElement>(`.react-pdf__Page[data-page-number="${n}"] canvas`)?.getBoundingClientRect().width ?? 0;
const scroller = () => document.querySelector<HTMLElement>('[data-testid="pdf-preview-pages"]')!;

describe('PdfPreview zoom', () => {
  it('re-renders the pages larger and lets them scroll sideways', async () => {
    const screen = await render(<ZoomFrame url={pdfURL(3)} />);
    // Fitted: as wide as the viewer (a canvas pdf.js hasn't drawn yet still
    // has the browser's default width, so wait for the fit itself).
    const viewer = document.querySelector<HTMLElement>('[data-testid="pdf-preview"]')!;
    const fitted = Math.min(900, Math.floor(viewer.getBoundingClientRect().width));
    await expect.poll(() => pageWidth(1), PDF_LOAD).toBeCloseTo(fitted, 0);
    expect(scroller().scrollWidth).toBeLessThanOrEqual(scroller().clientWidth);

    await screen.getByTestId('zoom-2').click();
    await expect.poll(() => pageWidth(1), PDF_LOAD).toBeCloseTo(fitted * 2, 0);
    expect(scroller().scrollWidth).toBeGreaterThan(scroller().clientWidth);
  });

  it('keeps the page you were reading in view as it zooms', async () => {
    const screen = await render(<ZoomFrame url={pdfURL(20)} />);
    await expect.poll(() => pageWidth(1), PDF_LOAD).toBeGreaterThan(0);
    const el = scroller();
    el.scrollTop = el.scrollHeight * 0.5;
    await expect.poll(() => renderedPages().some((p) => p.dataset.pageNumber === '11'), PDF_LOAD).toBe(true);
    const before = el.scrollTop;
    await screen.getByTestId('zoom-2').click();
    // The middle of the view is where it was: twice as far down the
    // twice-as-tall document.
    await expect.poll(() => el.scrollTop, PDF_LOAD).toBeGreaterThan(before * 1.8);
  });

  it('zooms with Ctrl/⌘ + wheel: scaled at once, re-rendered once the wheel rests', async () => {
    const onZoom = vi.fn();
    await render(<ZoomFrame url={pdfURL(2)} onZoom={onZoom} />);
    await expect.poll(() => pageWidth(1), PDF_LOAD).toBeGreaterThan(0);
    const viewer = document.querySelector<HTMLElement>('[data-testid="pdf-preview"]')!;
    const rect = viewer.getBoundingClientRect();
    const at = { clientX: rect.left + 100, clientY: rect.top + 100, bubbles: true, cancelable: true };

    // A plain wheel is the browser's scroll.
    const plain = new WheelEvent('wheel', { ...at, deltaY: -100 });
    scroller().dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);

    const wheel = new WheelEvent('wheel', { ...at, deltaY: -100, ctrlKey: true });
    scroller().dispatchEvent(wheel);
    scroller().dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: -100, metaKey: true }));
    // The app's zoom, not the browser's.
    expect(wheel.defaultPrevented).toBe(true);
    const content = viewer.querySelector<HTMLElement>('.react-pdf__Document')!;
    expect(content.style.transform).toMatch(/^scale\(1\.6/);
    await expect.poll(() => onZoom.mock.calls.length).toBe(1);
    expect(onZoom.mock.calls[0][0]).toBeCloseTo(1.65, 1);
    await expect.poll(() => content.style.transform).toBe('');

    // Zoomed all the way out already: wheeling further out changes nothing.
    onZoom.mockClear();
    scroller().dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: 100, ctrlKey: true }));
    scroller().dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: 100, ctrlKey: true }));
    scroller().dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: 100, ctrlKey: true }));
    await expect.poll(() => onZoom.mock.calls.length).toBe(1);
    expect(onZoom.mock.calls[0][0]).toBe(1);
    await expect.poll(() => content.style.transform).toBe('');
    onZoom.mockClear();
    scroller().dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: 100, ctrlKey: true }));
    await new Promise((r) => setTimeout(r, 300));
    expect(onZoom).not.toHaveBeenCalled();
    expect(content.style.transform).toBe('');
  });

  // Two fingers zoom (the browser only reports pinches where there is a
  // touchscreen); one finger stays the browser's scroll.
  it('zooms with a two-finger pinch, scaled at once and re-rendered on release', async () => {
    if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return;
    const onZoom = vi.fn();
    await render(<ZoomFrame url={pdfURL(2)} onZoom={onZoom} />);
    await expect.poll(() => pageWidth(1), PDF_LOAD).toBeGreaterThan(0);
    const viewer = document.querySelector<HTMLElement>('[data-testid="pdf-preview"]')!;
    const target = scroller();
    const rect = viewer.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // Synthetic pointers can't be captured (the browser knows no such
    // pointer), and the pinch recognizer captures each finger; stand in for
    // capture on this element only.
    const captured = new Set<number>();
    target.setPointerCapture = (id: number) => void captured.add(id);
    target.releasePointerCapture = (id: number) => void captured.delete(id);
    target.hasPointerCapture = (id: number) => captured.has(id);
    const pointer = (type: string, id: number, x: number) =>
      target.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: cy, bubbles: true, cancelable: true }));
    pointer('pointerdown', 1, cx - 40);
    pointer('pointerdown', 2, cx + 40);
    for (let i = 1; i <= 4; i++) {
      pointer('pointermove', 1, cx - 40 - i * 15);
      pointer('pointermove', 2, cx + 40 + i * 15);
    }
    const content = viewer.querySelector<HTMLElement>('.react-pdf__Document')!;
    await expect.poll(() => content.style.transform).toBe('scale(2.5)');
    pointer('pointerup', 1, cx - 100);
    pointer('pointerup', 2, cx + 100);
    await expect.poll(() => onZoom.mock.calls.length).toBe(1);
    expect(onZoom.mock.calls[0][0]).toBeCloseTo(2.5, 1);
    await expect.poll(() => content.style.transform).toBe('');
    // The pages scroll natively under one finger, and pinch to the app.
    expect(getComputedStyle(target).touchAction).toBe('pan-x pan-y');
  });

  it('is not zoomable without a zoom handler', async () => {
    await render(<Frame url={pdfURL(1)} />);
    await expect.poll(() => pageWidth(1), PDF_LOAD).toBeGreaterThan(0);
    const wheel = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    scroller().dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });
});
