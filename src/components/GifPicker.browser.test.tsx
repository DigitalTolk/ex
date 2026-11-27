import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render } from 'vitest-browser-react';
import { GifPicker } from './GifPicker';
import { fireKeyboard, keyboardSettled } from '@/test/keyboard';
import { KeyboardInsetTracker } from '@/test/KeyboardInsetTracker';
import { apiGif, apiList, json, ohmagifRequests, stubOhmagif, TEST_OHMAGIF_KEY } from '@/test/ohmagif';

// The real ohmagif Grid, over a stubbed API: a page of twelve, more than a
// phone's sheet shows at once.
const page = apiList(
  Array.from({ length: 12 }, (_, i) => apiGif(`Trend${String(i).padStart(5, '0')}`, { description: `GIF ${i}` })),
);

let spy: MockInstance<typeof fetch>;
beforeEach(() => {
  spy = stubOhmagif(() => json(page));
});
afterEach(() => spy.mockRestore());

function picker(onSelect = vi.fn()) {
  return <GifPicker apiKey={TEST_OHMAGIF_KEY} onSelect={onSelect} trigger={<button type="button">Open GIFs</button>} />;
}

describe('GifPicker browser behavior', () => {
  it('keeps the mobile picker content scrollable inside the bottom sheet', async () => {
    if (window.innerWidth > 767) return;
    const onSelect = vi.fn();
    const screen = await render(picker(onSelect));

    await screen.getByText('Open GIFs').click();
    const portal = screen.getByTestId('popover-portal');
    await expect.element(portal).toBeVisible();
    expect(portal.element()).toHaveAttribute('data-mobile-sheet', 'true');
    expect(Number.parseFloat(getComputedStyle(portal.element()).borderBottomWidth)).toBe(0);

    await expect.element(screen.getByRole('button', { name: 'GIF 11' })).toBeInTheDocument();
    const scroller = screen.getByTestId('gif-grid').element();
    expect(scroller).toHaveAttribute('data-swipe-scroll', 'true');
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    scroller.scrollTop = 160;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(scroller.scrollTop).toBeGreaterThan(0);

    await screen.getByRole('button', { name: 'GIF 0' }).click();
    // The 400x300 frame and its 24 px credit strip: the whole file.
    expect(onSelect).toHaveBeenCalledWith({ id: 'Trend00000', width: 400, height: 324 });
  });

  // Searching raises the keyboard; the GIFs it finds stay in sight above it.
  it('keeps the results above the keyboard while searching on a phone', async () => {
    if (window.innerWidth > 767) return;
    const KEYBOARD_PX = 300;
    const screen = await render(
      <>
        <KeyboardInsetTracker />
        {picker()}
      </>,
    );
    await screen.getByText('Open GIFs').click();
    await expect.element(screen.getByRole('button', { name: 'GIF 0' })).toBeVisible();
    try {
      (screen.getByLabelText('Search GIFs').element() as HTMLInputElement).focus();
      fireKeyboard('keyboardWillShow', KEYBOARD_PX);
      const keyboardTop = window.innerHeight - KEYBOARD_PX;
      const sheet = screen.getByTestId('popover-portal').element();
      await keyboardSettled(() => Math.round(sheet.getBoundingClientRect().bottom) === keyboardTop);
      const search = screen.getByLabelText('Search GIFs').element().getBoundingClientRect();
      const results = screen.getByTestId('gif-grid').element().getBoundingClientRect();
      expect(search.top).toBeGreaterThanOrEqual(0);
      expect(results.bottom).toBeLessThanOrEqual(keyboardTop + 1);
      // A useful stretch of results, not a sliver.
      expect(results.bottom - Math.max(results.top, search.bottom)).toBeGreaterThan(150);
    } finally {
      fireKeyboard('keyboardWillHide');
    }
  });

  it('focuses the search box on desktop and searches what is typed', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await render(picker());
    await screen.getByText('Open GIFs').click();
    const input = screen.getByLabelText('Search GIFs');
    await expect.element(input).toBeVisible();
    await vi.waitFor(() => expect(document.activeElement).toBe(input.element()));
    await input.fill('cats');
    await expect.poll(() => ohmagifRequests(spy)).toContain('/api/v1/search?q=cats&limit=12&offset=0&rating=pg');
  });

  // The grid fills the picker's width in two columns, GIF by GIF in its
  // own shape, and the popover keeps its height whatever it holds.
  it('lays the GIFs out in two columns across the grid', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await render(picker());
    await screen.getByText('Open GIFs').click();
    const first = screen.getByRole('button', { name: 'GIF 0' });
    await expect.element(first).toBeVisible();
    const grid = screen.getByTestId('gif-grid').element().getBoundingClientRect();
    // A tile is the card (1 px border) around the frame and its credit line.
    const a = first.element().parentElement!.getBoundingClientRect();
    const b = screen.getByRole('button', { name: 'GIF 1' }).element().parentElement!.getBoundingClientRect();
    const frame = first.element().getBoundingClientRect();
    expect(grid.width).toBe(336);
    expect(a.width).toBeCloseTo((336 - 6) / 2, 0);
    expect(frame.width).toBeCloseTo(a.width - 2, 0);
    // 4:3 frames, so 3/4 as high as wide, then the 18 px credit line.
    expect(frame.height).toBeCloseTo((frame.width * 3) / 4, 0);
    expect(a.height).toBeCloseTo(frame.height + 18 + 2, 0);
    expect(b.left - a.right).toBeCloseTo(6, 0);
    expect(b.top).toBeCloseTo(a.top, 0);
  });

  // Each GIF carries its creator's credit (ohmagif's terms), at the
  // library's own size, whole inside its line.
  it("shows each GIF's credit at the library's size, whole, under its frame", async () => {
    const screen = await render(picker());
    await screen.getByText('Open GIFs').click();
    const frame = screen.getByRole('button', { name: 'GIF 0' });
    await expect.element(frame).toBeVisible();
    const credit = frame.element().parentElement!.querySelector('.ohmagif-credit') as HTMLElement;
    expect(credit.textContent).toBe('by @maker');
    // Nothing in the app resizes it.
    expect(getComputedStyle(credit).fontSize).toBe(credit.style.fontSize);
    expect(credit.scrollHeight).toBeLessThanOrEqual(credit.clientHeight);
    expect(credit.scrollWidth).toBeLessThanOrEqual(credit.clientWidth);
    const f = frame.element().getBoundingClientRect();
    const c = credit.getBoundingClientRect();
    expect(c.top).toBeCloseTo(f.bottom, 0);
    expect(c.height).toBe(18);
  });
});
