import { useCallback, useMemo } from 'react';
import { GiphyFetch, type GifsResult } from '@giphy/js-fetch-api';
import { Grid } from '@giphy/react-components';
import type IGif from '@giphy/js-types/dist/gif';
import type { PickedGIF } from '@/components/GiphyPicker';

const PAGE_SIZE = 12;
const GRID_GUTTER = 6;

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

interface GiphyGridProps {
  apiKey: string;
  /** Already-debounced search term — the Grid resets when it changes. */
  query: string;
  width: number;
  columns: number;
  onPick: (gif: PickedGIF) => void;
}

// GiphyGrid owns every import that touches the Giphy SDK (fetch client +
// `<Grid>`). GiphyPicker loads it via React.lazy, so the @giphy vendor
// chunk leaves the main bundle and is fetched only when someone actually
// opens the GIF picker. The Grid handles infinite scroll, masonry layout,
// image rendering, and direct client-side requests to GIPHY via the SDK
// fetch client; this app does not proxy GIPHY API or media traffic.
export default function GiphyGrid({ apiKey, query, width, columns, onPick }: GiphyGridProps) {
  const gf = useMemo(() => new GiphyFetch(apiKey.trim()), [apiKey]);

  const fetchGifs = useCallback(
    (offset: number) => {
      if (!apiKey.trim()) return Promise.resolve(emptyGiphyResult(offset));
      const options = { offset, limit: PAGE_SIZE, rating: 'pg' as const };
      const term = query.trim();
      return term ? gf.search(term, options) : gf.trending(options);
    },
    [apiKey, query, gf],
  );

  const handleGifClick = useCallback(
    (gif: IGif, e: React.SyntheticEvent) => {
      // Grid renders gifs as anchor tags by default — preventDefault
      // stops the click from navigating to giphy.com.
      e.preventDefault();
      onPick({
        id: String(gif.id),
        title: gif.title || 'GIF',
        ...pickGIFDimensions(gif),
      });
    },
    [onPick],
  );

  return (
    <Grid
      key={query /* reset state when search changes */}
      width={width}
      columns={columns}
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
  );
}
