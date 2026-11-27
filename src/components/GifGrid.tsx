import { useCallback, useMemo, type ElementType } from 'react';
import type { Gif } from '@ohmagif/js';
import { Grid } from '@ohmagif/js/react';
import type { PickedGIF } from '@/components/GifPicker';
import { ohmagifClient } from '@/lib/ohmagif-client';

const PAGE_SIZE = 12;
const GRID_GUTTER = 6;

interface GifGridProps {
  apiKey: string;
  // Already debounced and trimmed: a new term is a new grid.
  query: string;
  width: number;
  columns: number;
  loader: ElementType;
  onPick: (gif: PickedGIF) => void;
}

// GifGrid is ohmagif's GIF grid, trending until something is searched. The
// lazily loaded half of GifPicker: it is what brings in @ohmagif/js.
export default function GifGrid({ apiKey, query, width, columns, loader, onPick }: GifGridProps) {
  const client = useMemo(() => ohmagifClient(apiKey), [apiKey]);

  // The grid asks for each next page as its end scrolls near; a new search
  // is a new grid (keyed on the term), from the first page.
  const fetchGifs = useCallback(
    (offset: number, signal: AbortSignal) => {
      const options = { offset, limit: PAGE_SIZE, rating: 'pg' as const, signal };
      return query ? client.search(query, options) : client.trending(options);
    },
    [client, query],
  );

  // The size of the whole file, credit strip included: what GifFromId
  // draws a message's GIF from.
  const pick = useCallback((gif: Gif) => onPick({ id: gif.id, width: gif.width, height: gif.height }), [onPick]);

  return (
    <Grid
      key={query}
      width={width}
      columns={columns}
      gutter={GRID_GUTTER}
      fetchGifs={fetchGifs}
      onGifClick={pick}
      // Each tile picks its GIF; its credit line ("by @handle", as
      // ohmagif's terms ask with every GIF) links out.
      noLink
      noResultsMessage={<p className="text-xs text-muted-foreground">No GIFs found</p>}
      errorMessage={<p className="text-xs text-muted-foreground">GIFs did not load</p>}
      loader={loader}
    />
  );
}
