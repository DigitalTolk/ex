import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// react-pdf requires the worker to be configured in the module that renders
// <Document>. Vite emits it as a same-origin asset, which the app CSP allows.
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const MAX_PAGE_WIDTH = 900;
const PAGE_GAP = 12;

interface PdfPreviewProps {
  url: string;
  // Shown instead of the viewer when the document cannot be loaded.
  fallback: ReactNode;
}

// PdfPreview renders a PDF as a scrollable column of pages. Pages are
// virtualized — only those near the viewport hold a canvas — so a long
// document costs a few pages of memory, not all of them.
export default function PdfPreview({ url, fallback }: PdfPreviewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VirtuosoHandle>(null);
  const [width, setWidth] = useState(0);
  const [numPages, setNumPages] = useState(0);
  // Placeholder page shape until page 1 reports its own (A4 portrait).
  const [aspect, setAspect] = useState(Math.SQRT2);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.min(MAX_PAGE_WIDTH, Math.floor(entry.contentRect.width)));
    });
    observer.observe(wrapperRef.current as HTMLDivElement);
    return () => observer.disconnect();
  }, []);

  // Reserve each page's box before its canvas renders; otherwise every
  // unrendered page measures 0px and the list would mount all of them.
  const pageHeight = Math.round(width * aspect) + PAGE_GAP;

  return (
    <div ref={wrapperRef} className="flex h-full w-full items-center justify-center" data-testid="pdf-preview">
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
          loading={<p className="text-center text-sm text-white/70">Loading…</p>}
          error={null}
          externalLinkTarget="_blank"
          onLoadSuccess={(pdf) => setNumPages(pdf.numPages)}
          onLoadError={() => setFailed(true)}
          onItemClick={({ pageNumber }) => listRef.current?.scrollToIndex({ index: pageNumber - 1 })}
        >
          {numPages > 0 && width > 0 && (
            <Virtuoso
              ref={listRef}
              className="h-full w-full overscroll-contain"
              data-testid="pdf-preview-pages"
              totalCount={numPages}
              defaultItemHeight={pageHeight}
              increaseViewportBy={pageHeight}
              itemContent={(index) => (
                <div className="flex justify-center" style={{ minHeight: pageHeight, paddingBottom: PAGE_GAP }}>
                  <Page
                    pageNumber={index + 1}
                    width={width}
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
