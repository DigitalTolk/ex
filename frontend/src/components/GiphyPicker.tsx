import { useCallback, useEffect, useRef, useState } from 'react';
import { Grid } from '@giphy/react-components';
import type IGif from '@giphy/js-types/dist/gif';
import { Input } from '@/components/ui/input';
import { PopoverPortal } from '@/components/PopoverPortal';
import { apiFetch } from '@/lib/api';

// PickedGIF is the shape we hand back to the composer — just the
// fields the message body needs. The Grid's onGifClick gives us a
// full IGif; we narrow it here so the composer doesn't pull the
// Giphy types into its own surface.
export interface PickedGIF {
  id: string;
  title: string;
  url: string;
  width: number;
  height: number;
}

interface GiphyPickerProps {
  onSelect: (gif: PickedGIF) => void;
  trigger: React.ReactNode;
  ariaLabel?: string;
}

const GRID_WIDTH = 336;
const GRID_COLUMNS = 2;
const GRID_GUTTER = 6;
const PAGE_SIZE = 12;

// SEARCH_DEBOUNCE_MS keeps us under the per-key Giphy rate limits and
// avoids the Grid restarting from scratch on every keystroke.
const SEARCH_DEBOUNCE_MS = 250;

// fetchFromProxy talks to our server-side proxy so the workspace's
// Giphy API key never reaches the browser. The Giphy SDK's `Grid`
// only requires the response to match GifsResult ({data, meta,
// pagination}) — our handler streams Giphy's raw envelope through.
function fetchFromProxy(query: string, offset: number, limit: number): Promise<unknown> {
  const path = query.trim()
    ? `/api/v1/giphy/search?q=${encodeURIComponent(query.trim())}&offset=${offset}&limit=${limit}`
    : `/api/v1/giphy/trending?offset=${offset}&limit=${limit}`;
  return apiFetch<unknown>(path);
}

// GiphyPicker opens a popover with a search box and the Giphy SDK's
// `<Grid>` component. The Grid handles infinite scroll, masonry
// layout, and image rendering — we only own the popover shell, the
// search input, and the proxy call.
export function GiphyPicker({ onSelect, trigger, ariaLabel = 'Giphy picker' }: GiphyPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const triggerRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
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
    // The Grid SDK's Promise<GifsResult> — our proxy returns the same
    // shape Giphy returns, so a structural cast is enough.
    (offset: number) => fetchFromProxy(debouncedQuery, offset, PAGE_SIZE) as Promise<never>,
    [debouncedQuery],
  );

  function close() {
    setOpen(false);
    setQuery('');
    setDebouncedQuery('');
  }

  const handleGifClick = useCallback(
    (gif: IGif, e: React.SyntheticEvent) => {
      // Grid renders gifs as anchor tags by default — preventDefault
      // stops the click from navigating to giphy.com.
      e.preventDefault();
      const original = gif.images.original;
      onSelect({
        id: String(gif.id),
        title: gif.title || 'GIF',
        url: original.url,
        width: original.width,
        height: original.height,
      });
      close();
    },
    [onSelect],
  );

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
        estimatedHeight={460}
        estimatedWidth={GRID_WIDTH + 24}
        preferredSide="bottom"
        preferredAlign="end"
        ariaLabel={ariaLabel}
        className="rounded-md border bg-popover p-3 shadow-md"
      >
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search GIFs..."
          aria-label="Search GIFs"
          className="mb-2 h-9 text-sm"
          data-testid="giphy-search"
        />
        <div
          className="max-h-80 overflow-y-auto"
          style={{ width: GRID_WIDTH }}
          data-testid="giphy-grid"
        >
          {open && (
            <Grid
              key={debouncedQuery /* reset state when search changes */}
              width={GRID_WIDTH}
              columns={GRID_COLUMNS}
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
        {/* Giphy's terms require attribution — we hide the SDK's own
            badge so we can render it consistently with our other
            popovers. */}
        <p className="mt-2 text-center text-[10px] text-muted-foreground">Powered by GIPHY</p>
      </PopoverPortal>
    </>
  );
}
