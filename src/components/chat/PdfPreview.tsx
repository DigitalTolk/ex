import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePinch } from '@use-gesture/react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { useZoomWheel } from '@/hooks/useZoomWheel';

// react-pdf requires the worker to be configured in the module that renders
// <Document>. Vite emits it as a same-origin asset, which the app CSP allows.
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const MAX_PAGE_WIDTH = 900;
const PAGE_GAP = 12;
// The most canvas pixels one page may hold. A zoomed page on a high-density
// screen would otherwise ask for a canvas iOS refuses, or a few that exhaust
// its memory; past this the page renders at a lower density instead.
const MAX_PAGE_PIXELS = 8_000_000;
// A Ctrl/⌘ + wheel zoom re-renders the pages once the wheel has been still
// this long; until then the pages are scaled as they are.
const WHEEL_SETTLE_MS = 150;

interface PdfPreviewProps {
  url: string;
  // Shown instead of the viewer when the document cannot be loaded.
  fallback: ReactNode;
  // Page size as a multiple of the width that fits the viewer.
  zoom?: number;
  maxZoom?: number;
  // A pinch, or Ctrl/⌘ + wheel, over the pages asks for a new zoom.
  onZoomChange?: (zoom: number) => void;
}

// PdfPreview renders a PDF as a scrollable column of pages. Pages are
// virtualized — only those near the viewport hold a canvas — so a long
// document costs a few pages of memory, not all of them. Zoomed, the pages
// re-render sharp at the larger size and scroll both ways; a pinch or a
// Ctrl/⌘ + wheel shows the new size at once (the pages scaled) and re-renders
// when it ends, keeping the point under the fingers or the pointer in place.
export default function PdfPreview({ url, fallback, zoom = 1, maxZoom = 1, onZoomChange }: PdfPreviewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<VirtuosoHandle>(null);
  const [fitWidth, setFitWidth] = useState(0);
  const [numPages, setNumPages] = useState(0);
  // Placeholder page shape until page 1 reports its own (A4 portrait).
  const [aspect, setAspect] = useState(Math.SQRT2);
  const [failed, setFailed] = useState(false);
  const zoomable = !!onZoomChange;

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setFitWidth(Math.min(MAX_PAGE_WIDTH, Math.floor(entry.contentRect.width)));
    });
    observer.observe(wrapperRef.current as HTMLDivElement);
    return () => observer.disconnect();
  }, []);

  const pageWidth = Math.round(fitWidth * zoom);
  // Reserve each page's box before its canvas renders; otherwise every
  // unrendered page measures 0px and the list would mount all of them.
  const pageHeight = Math.round(pageWidth * aspect) + PAGE_GAP;
  const density = Math.min(window.devicePixelRatio, Math.sqrt(MAX_PAGE_PIXELS / Math.max(1, pageWidth * pageWidth * aspect)));

  // Where the last zoom should keep its place, in viewer coordinates; the
  // middle of the viewer when nothing says (the toolbar's buttons).
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  // The scroll position as it was before the pages changed size.
  const scrollRef = useRef({ top: 0, left: 0 });
  const zoomRef = useRef(zoom);

  function preview(scale: number, clientX: number, clientY: number) {
    const rect = wrapperRef.current!.getBoundingClientRect();
    const el = contentRef.current!;
    el.style.transformOrigin = `${clientX - rect.left}px ${clientY - rect.top}px`;
    el.style.transform = `scale(${scale / zoom})`;
  }

  // Only ever after the pages exist (a gesture on them, or their resize).
  function clearPreview() {
    const el = contentRef.current!;
    el.style.transform = '';
    el.style.transformOrigin = '';
  }

  function commit(scale: number, clientX: number, clientY: number) {
    const next = Math.round(Math.min(maxZoom, Math.max(1, scale)) * 100) / 100;
    if (next === zoom) {
      clearPreview();
      return;
    }
    const rect = wrapperRef.current!.getBoundingClientRect();
    anchorRef.current = { x: clientX - rect.left, y: clientY - rect.top };
    onZoomChange?.(next);
  }

  // After a zoom: drop the preview scale and scroll so the anchored point is
  // where it was. The list takes a frame to measure the resized pages.
  useLayoutEffect(() => {
    const from = zoomRef.current;
    zoomRef.current = zoom;
    const el = scrollerRef.current;
    if (from === zoom || !el) return;
    clearPreview();
    const anchor = anchorRef.current ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    anchorRef.current = null;
    const ratio = zoom / from;
    const margin = (z: number) => Math.max(0, (el.clientWidth - fitWidth * z) / 2);
    const { top, left } = scrollRef.current;
    const target = {
      top: (top + anchor.y) * ratio - anchor.y,
      left: (left + anchor.x - margin(from)) * ratio + margin(zoom) - anchor.x,
    };
    const frame = requestAnimationFrame(() => el.scrollTo(target));
    return () => cancelAnimationFrame(frame);
  }, [zoom, fitWidth]);

  // Ctrl/⌘ + wheel: scale at once, re-render once the wheel rests.
  const wheelRef = useRef<{ scale: number; timer: number } | null>(null);
  useEffect(() => () => window.clearTimeout(wheelRef.current?.timer), []);
  const zoomWheelRef = useZoomWheel((event) => {
    const prev = wheelRef.current;
    window.clearTimeout(prev?.timer);
    const step = Math.max(-0.25, Math.min(0.25, -event.deltaY * 0.01));
    const scale = Math.min(maxZoom, Math.max(1, (prev?.scale ?? zoom) * Math.exp(step)));
    const { clientX, clientY } = event;
    const timer = window.setTimeout(() => {
      wheelRef.current = null;
      commit(scale, clientX, clientY);
    }, WHEEL_SETTLE_MS);
    wheelRef.current = { scale, timer };
    preview(scale, clientX, clientY);
  });

  // Two fingers (or Safari's trackpad gesture): the same, ending with the
  // pinch. One finger stays the browser's own scroll (touch-pan below).
  usePinch(
    ({ offset: [scale], origin: [x, y], last }) => {
      if (last) commit(scale, x, y);
      else preview(scale, x, y);
    },
    {
      target: wrapperRef,
      enabled: zoomable,
      pinchOnWheel: false,
      scaleBounds: { min: 1, max: maxZoom },
      from: () => [zoom, 0],
      eventOptions: { passive: false },
    },
  );

  const setWrapper = useCallback(
    (node: HTMLDivElement | null) => {
      wrapperRef.current = node;
      return zoomable ? zoomWheelRef(node) : undefined;
    },
    [zoomable, zoomWheelRef],
  );

  return (
    <div
      ref={setWrapper}
      className="flex h-full w-full items-center justify-center overflow-hidden"
      data-testid="pdf-preview"
      data-zoom={zoom}
    >
      {failed ? (
        fallback
      ) : (
        <Document
          file={url}
          // Explicit loading/error props instead of Suspense + error
          // boundaries: an unreadable PDF falls back to the download card
          // rather than surfacing as an app error.
          suspense={false}
          className="h-full w-full"
          inputRef={contentRef}
          loading={<p className="text-center text-sm text-white/70">Loading…</p>}
          error={null}
          externalLinkTarget="_blank"
          onLoadSuccess={(pdf) => setNumPages(pdf.numPages)}
          onLoadError={() => setFailed(true)}
          onItemClick={({ pageNumber }) => listRef.current?.scrollToIndex({ index: pageNumber - 1 })}
        >
          {numPages > 0 && fitWidth > 0 && (
            <Virtuoso
              ref={listRef}
              scrollerRef={(node) => {
                scrollerRef.current = node as HTMLElement | null;
              }}
              onScroll={(event) => {
                const el = event.currentTarget as HTMLElement;
                scrollRef.current = { top: el.scrollTop, left: el.scrollLeft };
              }}
              className="h-full w-full touch-pan-x touch-pan-y overscroll-contain"
              data-testid="pdf-preview-pages"
              totalCount={numPages}
              defaultItemHeight={pageHeight}
              increaseViewportBy={pageHeight}
              itemContent={(index) => (
                // Wider than the viewer once zoomed: it scrolls sideways.
                <div className="mx-auto" style={{ width: pageWidth, minHeight: pageHeight, paddingBottom: PAGE_GAP }}>
                  <Page
                    pageNumber={index + 1}
                    width={pageWidth}
                    devicePixelRatio={density}
                    loading={null}
                    className="shadow-2xl"
                    onLoadSuccess={index === 0 ? (page) => setAspect(page.originalHeight / page.originalWidth) : undefined}
                  />
                </div>
              )}
            />
          )}
        </Document>
      )}
    </div>
  );
}
