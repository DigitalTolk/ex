import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GiphyFetch, type GifsResult } from '@giphy/js-fetch-api';
import { Grid } from '@giphy/react-components';
import type IGif from '@giphy/js-types/dist/gif';
import { Input } from '@/components/ui/input';
import { PopoverPortal } from '@/components/PopoverPortal';

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
}

const MAX_GRID_WIDTH = 336;
const MIN_GRID_WIDTH = 180;
const POPOVER_HEIGHT = 460;
const GRID_GUTTER = 6;
const PAGE_SIZE = 12;
const POPOVER_MARGIN = 8;
const POPOVER_PADDING_X = 16;

// SEARCH_DEBOUNCE_MS keeps us under the per-key Giphy rate limits and
// avoids the Grid restarting from scratch on every keystroke.
const SEARCH_DEBOUNCE_MS = 250;

function pickGIFDimensions(gif: IGif) {
  const rendition = gif.images.original_mp4 || gif.images.original;
  return {
    width: rendition?.width,
    height: rendition?.height,
  };
}

function emptyGiphyResult(offset: number): GifsResult {
  return {
    data: [],
    pagination: { total_count: 0, count: 0, offset },
    meta: { status: 200, msg: 'OK', response_id: '' },
  };
}

function computeGridWidth() {
  if (typeof window === 'undefined') return MAX_GRID_WIDTH;
  const available = window.innerWidth - POPOVER_MARGIN * 2 - POPOVER_PADDING_X;
  return Math.max(MIN_GRID_WIDTH, Math.min(MAX_GRID_WIDTH, available));
}

// GiphyPicker opens a popover with a search box and the Giphy SDK's
// `<Grid>` component. The Grid handles infinite scroll, masonry layout,
// image rendering, and direct client-side requests to GIPHY via the
// SDK fetch client; this app does not proxy GIPHY API or media traffic.
export function GiphyPicker({ apiKey, onSelect, trigger, ariaLabel = 'Giphy picker' }: GiphyPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [gridWidth, setGridWidth] = useState(computeGridWidth);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const gf = useMemo(() => new GiphyFetch(apiKey.trim()), [apiKey]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

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

  const fetchGifs = useCallback(
    (offset: number) => {
      if (!apiKey.trim()) return Promise.resolve(emptyGiphyResult(offset));
      const options = { offset, limit: PAGE_SIZE, rating: 'pg' as const };
      const term = debouncedQuery.trim();
      return term ? gf.search(term, options) : gf.trending(options);
    },
    [apiKey, debouncedQuery, gf],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setDebouncedQuery('');
  }, []);

  const handleGifClick = useCallback(
    (gif: IGif, e: React.SyntheticEvent) => {
      // Grid renders gifs as anchor tags by default — preventDefault
      // stops the click from navigating to giphy.com.
      e.preventDefault();
      onSelect({
        id: String(gif.id),
        title: gif.title || 'GIF',
        ...pickGIFDimensions(gif),
      });
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
        onClick={() => setOpen((v) => !v)}
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
        className="flex h-[460px] max-w-[calc(100vw-16px)] flex-col rounded-md border bg-popover p-2 shadow-md"
      >
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search GIFs..."
          aria-label="Search GIFs"
          className="mb-2 h-9 shrink-0 text-sm"
          data-testid="giphy-search"
        />
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          style={{ width: gridWidth }}
          data-testid="giphy-grid"
        >
          {open && (
            <Grid
              key={debouncedQuery /* reset state when search changes */}
              width={gridWidth}
              columns={gridColumns}
              gutter={GRID_GUTTER}
              fetchGifs={fetchGifs}
              onGifClick={handleGifClick}
              noLink
              hideAttribution
              noResultsMessage={
                <p className="py-3 text-center text-xs text-muted-foreground">No GIFs found</p>
              }
              loader={() => (
                <p className="py-3 text-center text-xs text-muted-foreground">Loading…</p>
              )}
            />
          )}
        </div>
      </PopoverPortal>
    </>
  );
}
