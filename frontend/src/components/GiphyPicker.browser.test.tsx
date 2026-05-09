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
  Grid: ({ onGifClick }: { onGifClick: (gif: { id: string; title: string; images: { original: { width: string; height: string } } }, event: Event) => void }) => (
    <div style={{ height: 900 }} data-testid="mock-giphy-results">
      <button
        type="button"
        onClick={() => onGifClick({ id: 'gif-1', title: 'Test GIF', images: { original: { width: '320', height: '180' } } }, new Event('click'))}
      >
        Pick GIF
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
});
