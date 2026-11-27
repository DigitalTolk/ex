import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { PopoverPortal } from '@/components/PopoverPortal';
import { useAutoFocusTextInput } from '@/hooks/useHardwareKeyboard';

// The grid needs @ohmagif/js, which loads when the picker first opens.
const GifGrid = lazy(() => import('@/components/GifGrid'));

// PickedGIF is what the composer keeps of a picked GIF: its id and the
// size of its file. Its files' addresses come from the id.
export interface PickedGIF {
  id: string;
  width: number;
  height: number;
}

interface GifPickerProps {
  // The workspace's ohmagif key (ohmagifKey accepted it).
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

// SEARCH_DEBOUNCE_MS keeps a request per word rather than per keystroke:
// the grid starts over from the top for every new search.
const SEARCH_DEBOUNCE_MS = 250;

function computeGridWidth() {
  const available = window.innerWidth - POPOVER_MARGIN * 2 - POPOVER_PADDING_X;
  if (window.innerWidth <= 767) return Math.max(MIN_GRID_WIDTH, available);
  return Math.max(MIN_GRID_WIDTH, Math.min(MAX_GRID_WIDTH, available));
}

function GridLoading() {
  return <p className="py-3 text-center text-xs text-muted-foreground">Loading…</p>;
}

// GifPicker opens a popover with a search box over ohmagif's GIF grid:
// trending GIFs until something is typed, then the search's.
export function GifPicker({ apiKey, onSelect, trigger, ariaLabel = 'GIF picker', onOpenChange }: GifPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [gridWidth, setGridWidth] = useState(computeGridWidth);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoFocusTextInput = useAutoFocusTextInput();

  useEffect(() => {
    if (open && autoFocusTextInput) inputRef.current?.focus();
  }, [autoFocusTextInput, open]);

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

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
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
        className="flex h-[460px] max-w-[calc(100vw-16px)] flex-col rounded-md border bg-popover p-2 shadow-md touch:h-[50dvh] touch:w-screen touch:max-w-none touch:rounded-b-none touch:rounded-t-xl touch:border-x-0 touch:border-b-0 touch:pb-[calc(var(--sheet-safe-bottom,env(safe-area-inset-bottom))+0.5rem)]"
      >
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search GIFs"
          aria-label="Search GIFs"
          // No text-sm override — keep 16px on mobile (iOS zoom-on-focus).
          className="mb-2 h-9 touch:h-11 shrink-0"
          data-testid="gif-search"
        />
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          style={{ width: gridWidth, maxWidth: '100%' }}
          data-testid="gif-grid"
          data-swipe-scroll="true"
        >
          {open && (
            <Suspense fallback={<GridLoading />}>
              <GifGrid
                apiKey={apiKey}
                query={debouncedQuery}
                width={gridWidth}
                columns={gridColumns}
                loader={GridLoading}
                onPick={handlePick}
              />
            </Suspense>
          )}
        </div>
      </PopoverPortal>
    </>
  );
}
