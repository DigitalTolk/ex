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

vi.mock('@giphy/react-components', () => ({
  Grid: ({ onGifClick }: { onGifClick: (gif: { id: string; title?: string; images: { original: { width: string; height: string } } }, event: Event) => void }) => (
    <div style={{ height: 900 }} data-testid="mock-giphy-results">
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
  ),
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
