import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { GiphyPicker } from './GiphyPicker';

const giphyFetchMocks = vi.hoisted(() => ({
  search: vi.fn(),
  trending: vi.fn(),
}));

vi.mock('@giphy/js-fetch-api', () => ({
  GiphyFetch: vi.fn(function GiphyFetch() {
    return giphyFetchMocks;
  }),
}));

// Stub the Giphy SDK's <Grid> so the test exercises *our* wiring (the
// SDK fetch call, the search debounce, the gif-click handler) without
// pulling in the SDK's image-loading + IntersectionObserver code that
// jsdom doesn't model. The stub eagerly invokes fetchGifs on mount and
// renders one tile per returned item.
vi.mock('@giphy/react-components', async () => {
  const React = await import('react');
  type GridProps = {
    fetchGifs: (offset: number) => Promise<{ data: Array<{ id: string; title: string; images: { original: { url: string; width: number; height: number } } }> }>;
    onGifClick?: (gif: unknown, e: { preventDefault: () => void }) => void;
  };
  function Grid({ fetchGifs, onGifClick }: GridProps) {
    const [gifs, setGifs] = React.useState<GridProps extends { fetchGifs: (o: number) => Promise<{ data: infer D }> } ? D : never>([] as never);
    const [err, setErr] = React.useState<string | null>(null);
    React.useEffect(() => {
      let alive = true;
      setErr(null);
      fetchGifs(0)
        .then((r) => {
          if (!alive) return;
          setGifs(r.data as never);
        })
        .catch((e: Error) => {
          if (!alive) return;
          setErr(e.message);
        });
      return () => {
        alive = false;
      };
    }, [fetchGifs]);
    if (err) return React.createElement('p', { 'data-testid': 'grid-error' }, err);
    return React.createElement(
      'div',
      { 'data-testid': 'grid-stub' },
      (gifs as Array<{ id: string; title: string; images: { original: { url: string; width: number; height: number } } }>).map((g) =>
        React.createElement(
          'a',
          {
            key: g.id,
            href: '#',
            'data-testid': 'giphy-tile',
            'aria-label': g.title,
            onClick: (e: { preventDefault: () => void }) => onGifClick?.(g, e),
          },
          g.title,
        ),
      ),
    );
  }
  return { Grid };
});

const sampleResponse = {
  data: [
    {
      id: 'g-1',
      title: 'cat dance',
      images: {
        original: {
          url: 'https://media.giphy.com/g-1.gif',
          mp4: 'https://media.giphy.com/g-1-fallback.mp4?cid=keep',
          width: 300,
          height: 200,
        },
        original_mp4: {
          mp4: 'https://media.giphy.com/g-1.mp4?cid=keep',
          width: 300,
          height: 200,
        },
      },
    },
    {
      id: 'g-2',
      title: 'dog dance',
      images: {
        original: { url: 'https://media.giphy.com/g-2.gif', width: 250, height: 250 },
        original_mp4: { mp4: 'https://media.giphy.com/g-2.mp4', width: 250, height: 250 },
      },
    },
  ],
  pagination: { total_count: 2, count: 2, offset: 0 },
  meta: { status: 200, msg: 'OK', response_id: 'r-1' },
};

function renderPicker(onSelect: (gif: unknown) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(
    <QueryClientProvider client={qc}>
      <GiphyPicker apiKey="browser-key" onSelect={onSelect} trigger={<button>open gif</button>} />
    </QueryClientProvider>,
  );
}

describe('GiphyPicker', () => {
  beforeEach(() => {
    giphyFetchMocks.search.mockReset();
    giphyFetchMocks.trending.mockReset();
  });

  it('opens the picker and fetches trending GIFs directly through the Giphy SDK', async () => {
    giphyFetchMocks.trending.mockResolvedValue(sampleResponse);
    const user = userEvent.setup();
    renderPicker(vi.fn());

    await user.click(screen.getByText('open gif'));

    await waitFor(() => {
      expect(screen.getAllByTestId('giphy-tile')).toHaveLength(2);
    });
    expect(giphyFetchMocks.trending).toHaveBeenCalledWith({
      offset: 0,
      limit: 12,
      rating: 'pg',
    });
    expect(giphyFetchMocks.search).not.toHaveBeenCalled();
  });

  it('switches to SDK search when the user types and debounces the request', async () => {
    giphyFetchMocks.trending.mockResolvedValue(sampleResponse);
    giphyFetchMocks.search.mockResolvedValue(sampleResponse);
    const user = userEvent.setup();
    renderPicker(vi.fn());

    await user.click(screen.getByText('open gif'));
    await screen.findAllByTestId('giphy-tile');

    await user.type(screen.getByLabelText('Search GIFs'), 'cats');

    await waitFor(() => {
      expect(giphyFetchMocks.search).toHaveBeenCalledWith('cats', {
        offset: 0,
        limit: 12,
        rating: 'pg',
      });
    });
  });

  it('calls onSelect with the picked Giphy ID and dimensions, then closes the picker', async () => {
    giphyFetchMocks.trending.mockResolvedValue(sampleResponse);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderPicker(onSelect);

    await user.click(screen.getByText('open gif'));
    const tiles = await screen.findAllByTestId('giphy-tile');
    await user.click(tiles[0]);

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'g-1',
        title: 'cat dance',
        width: 300,
        height: 200,
      }),
    );
    expect(onSelect.mock.calls[0][0]).not.toHaveProperty('url');
    // The popover unmounts on dismissal — its search input is the
    // cleanest "still open?" probe.
    expect(screen.queryByLabelText('Search GIFs')).toBeNull();
  });

  it('surfaces an error state when the Giphy SDK call fails', async () => {
    giphyFetchMocks.trending.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    renderPicker(vi.fn());

    await user.click(screen.getByText('open gif'));
    expect(await screen.findByTestId('grid-error')).toHaveTextContent('boom');
  });

  it('keeps a static popup and grid height across content states', async () => {
    giphyFetchMocks.trending.mockResolvedValue(sampleResponse);
    const user = userEvent.setup();
    renderPicker(vi.fn());

    await user.click(screen.getByText('open gif'));

    expect(await screen.findByRole('dialog')).toHaveClass('h-[460px]');
    expect(screen.getByTestId('giphy-grid')).toHaveClass('flex-1');
    expect(screen.queryByText(/powered by giphy/i)).toBeNull();
  });
});
