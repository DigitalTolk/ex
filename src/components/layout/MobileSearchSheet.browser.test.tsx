import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { MemoryRouter } from 'react-router-dom';
import { MobileSearchSheet } from './MobileSearchSheet';
import { useKeyboardInsetTracker } from '@/hooks/useKeyboardInset';
import { deviceKind } from '@/lib/device';

function KeyboardTracker() {
  useKeyboardInsetTracker();
  return null;
}

// The search field itself is SearchBar's job (its own tests); stand it in
// with the hooks the sheet hands it.
vi.mock('@/components/SearchBar', () => ({
  SearchBar: ({ onDone, leading }: { onDone?: () => void; leading?: React.ReactNode }) => (
    <div>
      {leading}
      <input aria-label="Search" data-testid="searchbar-input" />
      <button type="button" data-testid="pick-result" onClick={onDone}>result</button>
      <div style={{ height: 3000 }} />
    </div>
  ),
}));

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <KeyboardTracker />
      <button type="button" data-testid="open-search" onClick={() => setOpen(true)}>
        Search
      </button>
      <span data-testid="state">{open ? 'open' : 'closed'}</span>
      <MobileSearchSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

const panel = () => document.querySelector<HTMLElement>('[data-testid="mobile-search-panel"]');
const state = () => document.querySelector('[data-testid="state"]')!.textContent;
const isPhone = () => window.matchMedia('(max-width: 767px)').matches && navigator.maxTouchPoints > 0;

// WebKit forbids constructing Touch objects, so dispatch a plain event
// carrying just what the sheet reads (React reads `touches` off it).
function touch(el: Element, type: 'touchstart' | 'touchmove' | 'touchend', y: number) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const touches = type === 'touchend' ? [] : [{ clientX: 100, clientY: y }];
  Object.defineProperty(ev, 'touches', { value: touches });
  Object.defineProperty(ev, 'changedTouches', { value: [{ clientX: 100, clientY: y }] });
  el.dispatchEvent(ev);
}

async function openSheet() {
  const screen = await render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
  const trigger = screen.getByTestId('open-search').element() as HTMLElement;
  trigger.focus();
  await screen.getByTestId('open-search').click();
  await vi.waitFor(() => expect(panel()).not.toBeNull());
  return { screen, trigger };
}

describe('MobileSearchSheet', () => {
  // A modal sheet: focus moves in (without raising the keyboard — the field
  // stays one tap away), and back to what opened it on close.
  it('opens as a half sheet with focus inside, and returns focus when a tap outside closes it', async () => {
    const { trigger } = await openSheet();
    expect(panel()).toHaveAttribute('data-expanded', 'false');
    expect(panel()).toHaveAttribute('role', 'dialog');
    expect(panel()).toHaveAccessibleName('Search');
    await vi.waitFor(() => expect(panel()!.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.querySelector('[data-testid="searchbar-input"]'));
    expect(document.querySelector('[data-testid="mobile-search-back"]')).toBeNull();

    (document.querySelector('[data-testid="mobile-search-backdrop"]') as HTMLElement).click();
    await vi.waitFor(() => expect(state()).toBe('closed'));
    await vi.waitFor(() => expect(panel()).toBeNull());
    // Base UI hands focus back after a pointer-driven close; after a touch
    // close on iOS it deliberately doesn't (that would re-raise the keyboard
    // or jump the page).
    if (deviceKind() !== 'touch') await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('grows to full screen when the results scroll, with a back button that closes it', async () => {
    await openSheet();
    const scroller = document.querySelector('[data-testid="mobile-search-scroll"]') as HTMLElement;
    expect(scroller).not.toHaveAttribute('data-base-ui-swipe-ignore');
    scroller.scrollTop = 40;
    scroller.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(panel()).toHaveAttribute('data-expanded', 'true'));
    // Full screen, a downward swipe scrolls the results instead of closing.
    expect(scroller).toHaveAttribute('data-base-ui-swipe-ignore');
    // Scrolling back to the very top doesn't shrink it again.
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    expect(panel()).toHaveAttribute('data-expanded', 'true');
    (document.querySelector('[data-testid="mobile-search-back"]') as HTMLElement).click();
    await vi.waitFor(() => expect(state()).toBe('closed'));
  });

  it('swipes up to grow', async () => {
    await openSheet();
    const p = panel()!;
    const body = document.querySelector('[data-testid="mobile-search-scroll"]')!;
    // A move with no start, and a short move, do nothing.
    touch(body, 'touchmove', 300);
    // A touch that starts outside the sheet doesn't count.
    touch(document.body, 'touchstart', 500);
    touch(body, 'touchmove', 300);
    expect(p).toHaveAttribute('data-expanded', 'false');
    touch(body, 'touchstart', 500);
    touch(body, 'touchmove', 490);
    expect(p).toHaveAttribute('data-expanded', 'false');
    touch(body, 'touchmove', 400);
    await vi.waitFor(() => expect(p).toHaveAttribute('data-expanded', 'true'));
    // Once grown, further moves change nothing.
    touch(body, 'touchmove', 200);
    touch(body, 'touchend', 200);
    expect(p).toHaveAttribute('data-expanded', 'true');
  });

  it('closes on Escape', async () => {
    await openSheet();
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(state()).toBe('closed'));
  });

  it('closes after a pick, dropping the keyboard with it', async () => {
    const { screen } = await openSheet();
    const input = screen.getByTestId('searchbar-input').element() as HTMLInputElement;
    input.focus();
    await screen.getByTestId('pick-result').click();
    await vi.waitFor(() => expect(state()).toBe('closed'));
    expect(document.activeElement).not.toBe(input);
  });

  it('opens fresh after closing (half sheet again)', async () => {
    const { screen } = await openSheet();
    const scroller = document.querySelector('[data-testid="mobile-search-scroll"]') as HTMLElement;
    scroller.scrollTop = 40;
    scroller.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(panel()).toHaveAttribute('data-expanded', 'true'));
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(panel()).toBeNull());
    await screen.getByTestId('open-search').click();
    await vi.waitFor(() => expect(panel()).toHaveAttribute('data-expanded', 'false'));
  });

  it('ends at the top of the keyboard and takes more of the room while it is up', async () => {
    await openSheet();
    const viewport = document.querySelector('[data-testid="mobile-search-sheet"]') as HTMLElement;
    expect(panel()).toHaveClass('h-[62%]');
    window.dispatchEvent(Object.assign(new Event('keyboardWillShow'), { keyboardHeight: 300 }));
    await vi.waitFor(() => expect(panel()).toHaveClass('h-[85%]'));
    expect(viewport.style.bottom).toBe('300px');
    window.dispatchEvent(new Event('keyboardWillHide'));
    await vi.waitFor(() => expect(panel()).toHaveClass('h-[62%]'));
  });

  // The phone's Back closes the sheet instead of leaving the screen (or the
  // app, in the Android shell) — the overlay contract every sheet follows.
  it('closes on the system Back on a phone', async () => {
    if (!isPhone()) return;
    await openSheet();
    window.history.back();
    await vi.waitFor(() => expect(state()).toBe('closed'));
  });
});
