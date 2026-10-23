import { useEffect, useReducer, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Download, FileCode, Monitor, RotateCw, ShieldAlert, Smartphone, Tablet, X, type LucideIcon } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { htmlPreviewURL } from '@/lib/html-attachment';
import {
  frameGuard,
  HTML_PREVIEW_PING,
  HTML_PREVIEW_SANDBOX,
  initialFrameGuard,
  newPreviewNonce,
  PING_INTERVAL_MS,
  readFrameSignal,
  READY_GRACE_MS,
} from '@/lib/html-preview';
import { cn } from '@/lib/utils';

export interface HtmlPreviewTarget {
  url: string;
  downloadURL?: string;
  filename: string;
}

interface HtmlPreviewPanelProps {
  attachment: HtmlPreviewTarget;
  onClose: () => void;
}

type Viewport = 'desktop' | 'tablet' | 'phone';

const VIEWPORTS: { key: Viewport; label: string; icon: LucideIcon }[] = [
  { key: 'desktop', label: 'Desktop width', icon: Monitor },
  { key: 'tablet', label: 'Tablet width (768px)', icon: Tablet },
  { key: 'phone', label: 'Phone width (390px)', icon: Smartphone },
];

const FRAME_WIDTH: Record<Viewport, string> = { desktop: '100%', tablet: '768px', phone: '390px' };

// The panel lives inside a message row's React tree (it portals to <body> in
// the DOM only), so React events from it bubble into the row: a press here
// would arm the row's long-press action sheet, or the files panel's swipe.
function keepInPanel(e: SyntheticEvent) {
  e.stopPropagation();
}

// HtmlPreviewPanel renders an HTML attachment live in a locked-down frame.
// See lib/html-preview.ts for the sandbox, CSP and frame-guard rationale.
// Lazy-loaded: the chat bundle only carries the Preview button.
export default function HtmlPreviewPanel({ attachment, onClose }: HtmlPreviewPanelProps) {
  const { url, downloadURL, filename } = attachment;
  const src = htmlPreviewURL(url);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  // Bumped to remount the frame, which loads the document again (Reload).
  const [frameKey, setFrameKey] = useState(0);
  const [guard, dispatch] = useReducer(frameGuard, initialFrameGuard);
  const [nonce] = useState(newPreviewNonce);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // The beacon in our document reports with the nonce; nothing else can.
  // Listening from mount (not from the frame's) so an early `ready` is never missed.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== frameRef.current?.contentWindow) return;
      const signal = readFrameSignal(e.data, nonce);
      if (signal) dispatch({ type: signal });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [nonce]);

  // Loaded but not (yet) proven ours: `ready` must follow promptly.
  const awaitingReady = guard.status === 'pending' && guard.loads > 0;
  useEffect(() => {
    if (!awaitingReady) return;
    const timer = setTimeout(() => dispatch({ type: 'ready-timeout' }), READY_GRACE_MS);
    return () => clearTimeout(timer);
  }, [awaitingReady]);

  // While shown, our document must keep answering. A frame that navigated to
  // a page that never finishes loading fires no second load; this catches it.
  const shown = guard.status === 'live';
  useEffect(() => {
    if (!shown) return;
    const interval = setInterval(() => {
      dispatch({ type: 'ping' });
      frameRef.current?.contentWindow?.postMessage(HTML_PREVIEW_PING, '*');
    }, PING_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [shown]);

  function reload() {
    dispatch({ type: 'reset' });
    setFrameKey((k) => k + 1);
  }

  let body: ReactNode;
  if (src === null || guard.status === 'failed') {
    body = (
      <div role="alert" className="m-auto flex flex-col items-center gap-3 p-6 text-center" data-testid="html-preview-error">
        <p className="text-sm font-medium">Couldn't load this file</p>
        {src !== null && (
          <Button variant="outline" size="sm" onClick={reload} data-testid="html-preview-retry">
            Try again
          </Button>
        )}
      </div>
    );
  } else if (guard.status === 'closed') {
    body = (
      <div role="status" className="m-auto flex max-w-sm flex-col items-center gap-3 p-6 text-center" data-testid="html-preview-navigated">
        <ShieldAlert className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm">This preview tried to open another page, so it was closed.</p>
        <Button variant="outline" size="sm" onClick={reload} data-testid="html-preview-reload-notice">
          Reload preview
        </Button>
      </div>
    );
  } else {
    const framed = viewport !== 'desktop';
    body = (
      <>
        {!shown && <StageMessage testId="html-preview-verifying">Loading…</StageMessage>}
        <iframe
          key={frameKey}
          ref={frameRef}
          // Every attribute is set before the element is inserted (which is
          // when it starts loading), so the document never runs with a wider
          // sandbox and always finds its nonce in window.name.
          sandbox={HTML_PREVIEW_SANDBOX}
          name={nonce}
          src={src}
          title={`Preview of ${filename}`}
          referrerPolicy="no-referrer"
          data-testid="html-preview-frame"
          data-guard={guard.status}
          // Hidden until proven to be our document, so an outside page the
          // file navigated to before its own load is never on screen.
          // mx-auto (not justify-center on the stage): an overflowing centred
          // flex item would be cut off on the left with no way to scroll to it.
          // bg-white + light scheme: a page's default canvas, in either theme.
          className={cn(
            'mx-auto block h-full shrink-0 border-0 bg-white [color-scheme:light]',
            framed && 'rounded-md shadow-lg ring-1 ring-foreground/10',
            !shown && 'invisible',
          )}
          style={{ width: FRAME_WIDTH[viewport] }}
          onLoad={() => dispatch({ type: 'load' })}
        />
      </>
    );
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        size="3xl"
        showCloseButton={false}
        data-testid="html-preview-panel"
        onPointerDown={keepInPanel}
        onContextMenu={keepInPanel}
        // Desktop: a near-full-viewport dialog (mockups need the room).
        // Mobile: the dialog primitive already goes full-screen; drop its
        // padding so the frame runs edge to edge under a safe-area toolbar.
        className="h-[calc(100dvh-4rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[min(1600px,calc(100%-4rem))] mobile:h-auto mobile:overflow-hidden mobile:p-0"
      >
        <div className="flex items-center gap-2 border-b px-3 py-2 mobile:pt-[calc(env(safe-area-inset-top)+0.5rem)]">
          <FileCode className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm leading-tight font-semibold">{filename}</DialogTitle>
            <DialogDescription className="truncate text-xs">
              Preview — content runs in an isolated frame
            </DialogDescription>
          </div>
          {/* A phone already is the phone width. */}
          <div role="group" aria-label="Preview width" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5 mobile:hidden">
            {VIEWPORTS.map(({ key, label, icon: Icon }) => (
              <Button
                key={key}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={label}
                title={label}
                aria-pressed={viewport === key}
                data-testid={`html-preview-width-${key}`}
                className="aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
                onClick={() => setViewport(key)}
              >
                <Icon />
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Reload preview"
            title="Reload preview"
            disabled={src === null}
            onClick={reload}
            data-testid="html-preview-reload"
          >
            <RotateCw />
          </Button>
          <a
            href={downloadURL ?? url}
            download={filename}
            aria-label={`Download ${filename}`}
            title="Download"
            data-testid="html-preview-download"
            className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
          >
            <Download />
          </a>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close preview"
            title="Close"
            onClick={onClose}
            data-testid="html-preview-close"
          >
            <X />
          </Button>
        </div>
        <div
          className={cn(
            'relative flex min-h-0 overflow-auto bg-muted mobile:p-0 mobile:pb-[env(safe-area-inset-bottom)]',
            viewport !== 'desktop' && 'p-4',
          )}
          data-testid="html-preview-stage"
        >
          {body}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StageMessage({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <p role="status" className="absolute inset-0 m-auto h-fit text-center text-sm text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}
