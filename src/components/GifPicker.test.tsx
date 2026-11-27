import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GifPicker } from './GifPicker';
import { apiGif, apiList, json, ohmagifRequests, stubOhmagif, TEST_OHMAGIF_KEY, type OhmagifAnswer } from '@/test/ohmagif';

// GifPicker renders inside PopoverPortal, whose Motion swipe hook runs a
// mount animation that hangs jsdom; stub it and capture the swipe-down
// dismiss callback so the dismiss path can be driven directly (drag
// physics are unit-tested in useSwipeDismiss.test).
const swipe = vi.hoisted(() => ({ fire: undefined as (() => void) | undefined }));
vi.mock('@/hooks/useSwipeDismiss', () => ({
  useSwipeDismiss: (_dir: string, onDismiss: () => void) => {
    swipe.fire = onDismiss;
    return { dismissing: false, motionProps: {} };
  },
}));

// GifGrid arrives via React.lazy. Pre-load its module so the lazy
// resolution is a deterministic microtask inside the tests' own awaited
// act()s rather than chunk I/O between them.
beforeAll(async () => {
  await import('@/components/GifGrid');
});

// The real ohmagif Grid runs: jsdom has no IntersectionObserver, so it asks
// for the first page at once and shows it whole.
const trending = apiList([
  apiGif('Trend00001', { description: 'cat dance', width: 400, height: 300, handle: 'catlover' }),
  apiGif('Trend00002', { description: 'dog dance', width: 480, height: 270, handle: 'dogfan' }),
]);
const cats = apiList([apiGif('CatSearch1', { description: 'cat search' })]);

let spy: MockInstance<typeof fetch>;
function answer(fn: OhmagifAnswer) {
  spy.mockRestore();
  spy = stubOhmagif(fn);
}

beforeEach(() => {
  setMobileMatch(false);
  spy = stubOhmagif((url) => json(url.pathname === '/api/v1/search' ? cats : trending));
});

afterEach(async () => {
  // Drain the Grid's settling page inside act before the test ends.
  await act(async () => {});
  spy.mockRestore();
});

function renderPicker(onSelect: (gif: unknown) => void = vi.fn()) {
  return render(
    <GifPicker apiKey={TEST_OHMAGIF_KEY} onSelect={onSelect} trigger={<button>open gif</button>} />,
  );
}

function setMobileMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

describe('GifPicker', () => {
  it('opens on the trending GIFs from ohmagif', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByText('open gif'));

    expect(await screen.findByRole('button', { name: 'cat dance' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'dog dance' })).toBeInTheDocument();
    expect(ohmagifRequests(spy)).toEqual(['/api/v1/trending?limit=12&offset=0&rating=pg']);
  });

  // ohmagif's terms: show the creator's handle with each GIF.
  it("credits each GIF's creator, linked to the GIF on ohmagif", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByText('open gif'));
    await screen.findByRole('button', { name: 'cat dance' });
    const credits = screen.getAllByRole('link', { name: /^by @/ });
    expect(credits.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')])).toEqual([
      ['by @catlover', 'https://ohmagif.com/g/Trend00001', '_blank'],
      ['by @dogfan', 'https://ohmagif.com/g/Trend00002', '_blank'],
    ]);
  });

  it('searches what is typed, once the typing pauses', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByText('open gif'));
    await screen.findByRole('button', { name: 'cat dance' });
    await user.type(screen.getByLabelText('Search GIFs'), '  cats ');

    expect(await screen.findByRole('button', { name: 'cat search' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'cat dance' })).toBeNull();
    expect(ohmagifRequests(spy)).toEqual([
      '/api/v1/trending?limit=12&offset=0&rating=pg',
      '/api/v1/search?q=cats&limit=12&offset=0&rating=pg',
    ]);
  });

  it("hands back the picked GIF's id and its file's size, never a file address, and closes", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderPicker(onSelect);

    await user.click(screen.getByText('open gif'));
    await user.click(await screen.findByRole('button', { name: 'dog dance' }));

    // A 480x270 frame, and the 24 px credit strip under it: the whole file.
    expect(onSelect).toHaveBeenCalledWith({ id: 'Trend00002', width: 480, height: 294 });
    // The popover unmounts on dismissal — its search input is the
    // cleanest "still open?" probe.
    expect(screen.queryByLabelText('Search GIFs')).toBeNull();
  });

  it('blurs the search field before closing after a pick', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByText('open gif'));
    const search = screen.getByLabelText('Search GIFs');
    expect(document.activeElement).toBe(search);
    await user.click(await screen.findByRole('button', { name: 'cat dance' }));

    expect(document.activeElement).not.toBe(search);
    expect(screen.queryByLabelText('Search GIFs')).toBeNull();
  });

  it('says when nothing matches, with the way to upload one', async () => {
    answer(() => json(apiList([])));
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByText('open gif'));
    expect(await screen.findByText('No GIFs found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upload to ohmagif' })).toHaveAttribute('href', 'https://ohmagif.com/upload');
  });

  it('says when the GIFs did not load, and tries again on Retry', async () => {
    let fail = true;
    answer(() => (fail ? json({ code: 'http_500', error: 'down' }, 500) : json(trending)));
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByText('open gif'));
    expect(await screen.findByText('GIFs did not load')).toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'cat dance' })).toBeInTheDocument();
  });

  it('shows the loading line while a page is on its way', async () => {
    answer(() => new Promise<Response>(() => {}));
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByText('open gif'));
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
  });

  it('lays the GIFs out in one column once the room is narrow', async () => {
    const realWidth = window.innerWidth;
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('open gif'));
    // The tile is the card around the GIF's frame button and its credit.
    const tile = (await screen.findByRole('button', { name: 'cat dance' })).parentElement!;
    try {
      // 220 px leaves a 188 px grid, under the 260 px two columns need.
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 220 });
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      await waitFor(() => expect(tile).toHaveStyle({ width: '188px' }));
      expect(screen.getByTestId('gif-grid')).toHaveStyle({ width: '188px' });
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
    }
  });

  it('does not autofocus the search field on mobile', async () => {
    setMobileMatch(true);
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByText('open gif'));

    expect(await screen.findByRole('dialog')).toHaveAttribute('data-mobile-sheet', 'true');
    expect(document.activeElement).not.toBe(screen.getByLabelText('Search GIFs'));
  });

  it('caps the mobile sheet at half the viewport so it overlays the composer without taking the page', async () => {
    setMobileMatch(true);
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByText('open gif'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('data-mobile-sheet', 'true');
    expect(dialog.className).toContain('touch:h-[50dvh]');
    // Declared in dvh (the visible viewport on a phone, not the one behind its
    // browser bars); computed, that is half the window's height.
    expect(dialog.style.maxHeight).toBe('50dvh');
    expect(getComputedStyle(dialog).maxHeight).toBe(`${window.innerHeight / 2}px`);
    expect(dialog).toHaveStyle({ overscrollBehaviorY: 'contain' });
  });

  it('closes the mobile sheet on a swipe down, and opens it again', async () => {
    setMobileMatch(true);
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByText('open gif'));
    await screen.findByRole('dialog');
    act(() => swipe.fire?.());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByText('open gif'));
    const reopened = await screen.findByRole('dialog');
    expect(reopened).toHaveAttribute('data-swipe-dismissing', 'false');
  });

  it('keeps a static popup and grid height across content states', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByText('open gif'));

    expect(await screen.findByRole('dialog', { name: 'GIF picker' })).toHaveClass('h-[460px]');
    expect(screen.getByTestId('gif-grid')).toHaveClass('flex-1');
    await screen.findByRole('button', { name: 'cat dance' });
  });
});
