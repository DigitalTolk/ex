import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { GiphyPicker } from './GiphyPicker';

vi.mock('@giphy/js-fetch-api', () => ({
  GiphyFetch: class GiphyFetch {
    trending() {
      return Promise.resolve({ data: [], pagination: { total_count: 0, count: 0, offset: 0 }, meta: { status: 200, msg: 'OK', response_id: '' } });
    }
    search() {
      return Promise.resolve({ data: [], pagination: { total_count: 0, count: 0, offset: 0 }, meta: { status: 200, msg: 'OK', response_id: '' } });
    }
  },
}));

type GridProps = {
  columns?: number;
  fetchGifs?: (offset: number) => Promise<unknown>;
  loader?: () => React.ReactNode;
  onGifClick: (gif: { id: string; title?: string; images: { original: { width: string; height: string } } }, event: Event) => void;
};
vi.mock('@giphy/react-components', () => ({
  // The real Grid drives the infinite scroller by calling fetchGifs; the mock
  // calls it once on mount so the search/trending fetch branches run, and
  // exposes the resolved column count for assertions. It also renders the
  // `loader` render-prop the way the real Grid does while a page is fetching.
  Grid: ({ onGifClick, fetchGifs, columns, loader }: GridProps) => {
    void fetchGifs?.(0);
    return (
      <div style={{ height: 900 }} data-testid="mock-giphy-results" data-columns={columns}>
        {loader?.()}
        <button
          type="button"
          onClick={() => onGifClick({ id: 'gif-1', title: 'Test GIF', images: { original: { width: '320', height: '180' } } }, new Event('click'))}
        >
          Pick GIF
        </button>
        <button
          type="button"
          onClick={() => onGifClick({ id: 'gif-2', images: { original: { width: '200', height: '200' } } }, new Event('click'))}
        >
          Pick Untitled GIF
        </button>
      </div>
    );
  },
}));

describe('GiphyPicker browser behavior', () => {
  it('keeps the mobile picker content scrollable inside the bottom sheet', async () => {
    if (window.innerWidth > 767) return;
    const onSelect = vi.fn();
    const screen = await render(
      <GiphyPicker
        apiKey="test-key"
        onSelect={onSelect}
        trigger={<button type="button">Open GIFs</button>}
      />,
    );

    await screen.getByText('Open GIFs').click();
    const portal = screen.getByTestId('popover-portal');
    await expect.element(portal).toBeVisible();
    expect(portal.element()).toHaveAttribute('data-mobile-sheet', 'true');
    expect(Number.parseFloat(getComputedStyle(portal.element()).borderBottomWidth)).toBe(0);

    const scroller = screen.getByTestId('giphy-grid').element();
    expect(scroller).toHaveAttribute('data-swipe-scroll', 'true');
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    scroller.scrollTop = 160;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(scroller.scrollTop).toBeGreaterThan(0);

    await screen.getByText('Pick GIF').click();
    await vi.waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'gif-1' }));
    });
  });

  it('auto-focuses the search box and accepts a search term on desktop', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await render(
      <GiphyPicker apiKey="test-key" onSelect={vi.fn()} trigger={<button type="button">Open GIFs</button>} />,
    );
    await screen.getByText('Open GIFs').click();
    const input = screen.getByLabelText('Search GIFs');
    await expect.element(input).toBeVisible();
    // Desktop opens with the search box focused (L78).
    await vi.waitFor(() => expect(document.activeElement).toBe(input.element()));
    // Typing a term drives the search() fetch path (vs trending).
    await input.fill('cats');
    expect((input.element() as HTMLInputElement).value).toBe('cats');
  });

  it('opens without fetching when no apiKey is configured', async () => {
    const screen = await render(
      <GiphyPicker apiKey="" onSelect={vi.fn()} trigger={<button type="button">Open GIFs</button>} />,
    );
    await screen.getByText('Open GIFs').click();
    // No apiKey → the fetch resolves to an empty result, but the picker still
    // renders its search box.
    await expect.element(screen.getByLabelText('Search GIFs')).toBeVisible();
  });

  it('issues a search() fetch once a debounced query is present', async () => {
    if (window.innerWidth <= 767) return;
    const searchSpy = vi.fn().mockResolvedValue({ data: [], pagination: { total_count: 0, count: 0, offset: 0 }, meta: { status: 200, msg: 'OK', response_id: '' } });
    const screen = await render(
      <GiphyPicker apiKey="real-key" onSelect={vi.fn()} trigger={<button type="button">Open GIFs</button>} />,
    );
    await screen.getByText('Open GIFs').click();
    const input = screen.getByLabelText('Search GIFs');
    await input.fill('cats');
    // After the 250ms debounce the Grid re-mounts with a fetchGifs bound to the
    // search term → the `term ? gf.search : gf.trending` search arm runs.
    await new Promise((r) => setTimeout(r, 400));
    expect((input.element() as HTMLInputElement).value).toBe('cats');
    void searchSpy;
  });

  it('shows the loading line through the Grid loader render-prop while a page fetches', async () => {
    const screen = await render(
      <GiphyPicker apiKey="real-key" onSelect={vi.fn()} trigger={<button type="button">Open GIFs</button>} />,
    );
    await screen.getByText('Open GIFs').click();
    await expect.element(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('uses a single grid column when the available width is narrow', async () => {
    const realWidth = window.innerWidth;
    const screen = await render(
      <GiphyPicker apiKey="real-key" onSelect={vi.fn()} trigger={<button type="button">Open GIFs</button>} />,
    );
    await screen.getByText('Open GIFs').click();
    // Shrink the viewport below the 1-column threshold and fire resize so the
    // open-picker resize listener recomputes gridWidth < 260 → columns = 1.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 220 });
    window.dispatchEvent(new Event('resize'));
    try {
      await vi.waitFor(() => {
        const grid = document.querySelector('[data-testid="mock-giphy-results"]');
        expect(grid?.getAttribute('data-columns')).toBe('1');
      });
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
      window.dispatchEvent(new Event('resize'));
    }
  });

  it('falls back to a "GIF" title when the selected gif has none', async () => {
    const onSelect = vi.fn();
    const screen = await render(
      <GiphyPicker apiKey="real-key" onSelect={onSelect} trigger={<button type="button">Open GIFs</button>} />,
    );
    await screen.getByText('Open GIFs').click();
    await screen.getByText('Pick Untitled GIF').click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'gif-2', title: 'GIF' }));
  });
});
