import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { PopoverPortal } from '@/components/PopoverPortal';
import { useIsMobile } from '@/hooks/useIsMobile';

// The grid is the only part that touches the Giphy SDK; lazy-loading it
// keeps the ~1MB @giphy vendor chunk out of the main bundle until a user
// actually opens the GIF picker.
const GiphyGrid = lazy(() => import('@/components/GiphyGrid'));

// PickedGIF is the shape we hand back to the composer: just the fields
// the message body needs. The Grid's onGifClick gives us a full IGif;
// we narrow it here so the composer doesn't pull Giphy types into its
// own surface.
export interface PickedGIF {
  id: string;
  title: string;
  width?: number;
  height?: number;
}

interface GiphyPickerProps {
  apiKey: string;
  onSelect: (gif: PickedGIF) => void;
  trigger: React.ReactNode;
  ariaLabel?: string;
  onOpenChange?: (open: boolean) => void;
}

const MAX_GRID_WIDTH = 336;
const MIN_GRID_WIDTH = 180;
const POPOVER_HEIGHT = 380;
const POPOVER_MARGIN = 8;
const POPOVER_PADDING_X = 16;

// SEARCH_DEBOUNCE_MS keeps us under the per-key Giphy rate limits and
// avoids the Grid restarting from scratch on every keystroke.
const SEARCH_DEBOUNCE_MS = 250;

function computeGridWidth() {
  /* istanbul ignore next -- SSR guard: this app is browser-only, so window is always defined in tests */
  if (typeof window === 'undefined') return MAX_GRID_WIDTH;
  const available = window.innerWidth - POPOVER_MARGIN * 2 - POPOVER_PADDING_X;
  if (window.innerWidth <= 767) return Math.max(MIN_GRID_WIDTH, available);
  return Math.max(MIN_GRID_WIDTH, Math.min(MAX_GRID_WIDTH, available));
}

// GiphyPicker opens a popover with a search box and the lazily-loaded
// GiphyGrid (the Giphy SDK's `<Grid>` behind React.lazy).
export function GiphyPicker({ apiKey, onSelect, trigger, ariaLabel = 'Giphy picker', onOpenChange }: GiphyPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [gridWidth, setGridWidth] = useState(computeGridWidth);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (open && !isMobile) inputRef.current?.focus();
  }, [isMobile, open]);

  useEffect(() => {
    if (!open) return;
    function updateWidth() {
      setGridWidth(computeGridWidth());
    }
    updateWidth();
    window.addEventListener('resize', updateWidth);
    window.visualViewport?.addEventListener('resize', updateWidth);
    return () => {
      window.removeEventListener('resize', updateWidth);
      window.visualViewport?.removeEventListener('resize', updateWidth);
    };
  }, [open]);

  // Debounce the query so the Grid doesn't reset its scroller on
  // every keystroke. The Grid keys off the fetchGifs identity, so a
  // fresh callback (built from `debouncedQuery`) is what triggers a
  // re-fetch.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  const close = useCallback(() => {
    inputRef.current?.blur();
    setOpen(false);
    onOpenChange?.(false);
    setQuery('');
    setDebouncedQuery('');
  }, [onOpenChange]);

  const handlePick = useCallback(
    (gif: PickedGIF) => {
      onSelect(gif);
      close();
    },
    [close, onSelect],
  );

  const gridColumns = gridWidth < 260 ? 1 : 2;

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-block"
        onClick={() => {
          setOpen((v) => {
            const next = !v;
            onOpenChange?.(next);
            return next;
          });
        }}
      >
        {trigger}
      </span>
      <PopoverPortal
        open={open}
        triggerRef={triggerRef}
        onDismiss={close}
        estimatedHeight={POPOVER_HEIGHT}
        estimatedWidth={gridWidth + POPOVER_PADDING_X}
        preferredSide="bottom"
        preferredAlign="end"
        ariaLabel={ariaLabel}
        mobileSheet
        className="flex h-[460px] max-w-[calc(100vw-16px)] flex-col rounded-md border bg-popover p-2 shadow-md mobile:h-[50dvh] mobile:w-screen mobile:max-w-none mobile:rounded-b-none mobile:rounded-t-xl mobile:border-x-0 mobile:border-b-0 mobile:pb-[calc(env(safe-area-inset-bottom)+0.5rem)]"
      >
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search GIFs..."
          aria-label="Search GIFs"
          // No text-sm override — keep 16px on mobile (iOS zoom-on-focus).
          className="mb-2 h-9 mobile:h-11 shrink-0"
          data-testid="giphy-search"
        />
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          style={{ width: gridWidth, maxWidth: '100%' }}
          data-testid="giphy-grid"
          data-swipe-scroll="true"
        >
          {open && (
            <Suspense
              fallback={
                <p className="py-3 text-center text-xs text-muted-foreground">Loading…</p>
              }
            >
              <GiphyGrid
                apiKey={apiKey}
                query={debouncedQuery}
                width={gridWidth}
                columns={gridColumns}
                onPick={handlePick}
              />
            </Suspense>
          )}
        </div>
        <a
          href="https://giphy.com/"
          target="_blank"
          rel="noreferrer"
          className="mt-2 shrink-0 self-end text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          Powered by GIPHY
        </a>
      </PopoverPortal>
    </>
  );
}
