import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { MobileSearchSheet } from './MobileSearchSheet';
import { useKeyboardInsetTracker } from '@/hooks/useKeyboardInset';

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

const panel = () => document.querySelector('[role="dialog"][aria-label="Search"]') as HTMLElement;
const settle = () => new Promise((r) => setTimeout(r, 450));

function touch(el: Element, type: 'touchstart' | 'touchmove' | 'touchend', y: number) {
  const t = new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
  el.dispatchEvent(
    new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] }),
  );
}

async function mount() {
  const onClose = vi.fn();
  const screen = await render(
    <MemoryRouter>
      <MobileSearchSheet onClose={onClose} />
    </MemoryRouter>,
  );
  await settle();
  return { screen, onClose };
}

describe('MobileSearchSheet', () => {
  it('slides up as a half sheet, then slides down before closing on a tap outside', async () => {
    const { onClose } = await mount();
    expect(panel().style.transform).toMatch(/^translateY\(0(px)?\)$/);
    expect(panel()).toHaveAttribute('data-expanded', 'false');
    expect(document.querySelector('[data-testid="mobile-search-back"]')).toBeNull();
    (document.querySelector('[data-testid="mobile-search-backdrop"]') as HTMLElement).click();
    await vi.waitFor(() => expect(panel().style.transform).toBe('translateY(100%)'));
    expect(onClose).not.toHaveBeenCalled();
    // A second close request while sliding out is ignored.
    (document.querySelector('[data-testid="mobile-search-backdrop"]') as HTMLElement).click();
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('grows to full screen when the results scroll, with a back button that closes it', async () => {
    const { onClose } = await mount();
    const scroller = panel().querySelector('.overflow-y-auto') as HTMLElement;
    scroller.scrollTop = 40;
    scroller.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(panel()).toHaveAttribute('data-expanded', 'true'));
    // Scrolling back to the very top doesn't shrink it again.
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    (document.querySelector('[data-testid="mobile-search-back"]') as HTMLElement).click();
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('swipes up to grow and, on the half sheet, swipes down to close', async () => {
    const { onClose } = await mount();
    const p = panel();
    // A move with no start, and a short move, do nothing.
    touch(p, 'touchmove', 300);
    touch(p, 'touchstart', 500);
    touch(p, 'touchmove', 490);
    expect(p).toHaveAttribute('data-expanded', 'false');
    touch(p, 'touchmove', 400);
    await vi.waitFor(() => expect(p).toHaveAttribute('data-expanded', 'true'));
    touch(p, 'touchend', 400);
    // Swiping down on the full-screen sheet doesn't close it (back does).
    touch(p, 'touchstart', 200);
    touch(p, 'touchmove', 500);
    touch(p, 'touchend', 500);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a downward swipe of the half sheet', async () => {
    const { onClose } = await mount();
    touch(panel(), 'touchstart', 400);
    touch(panel(), 'touchmove', 520);
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape, ignoring other keys', async () => {
    const { onClose } = await mount();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes after a pick, dropping the keyboard with it', async () => {
    const { onClose, screen } = await mount();
    const input = screen.getByTestId('searchbar-input').element() as HTMLInputElement;
    input.focus();
    await screen.getByTestId('pick-result').click();
    expect(document.activeElement).not.toBe(input);
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes cleanly from the half sheet with nothing focused', async () => {
    const { onClose } = await mount();
    (document.activeElement as HTMLElement | null)?.blur?.();
    (document.querySelector('[data-testid="mobile-search-backdrop"]') as HTMLElement).click();
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ends at the top of the keyboard and takes more of the room while it is up', async () => {
    await render(
      <MemoryRouter>
        <KeyboardTracker />
        <MobileSearchSheet onClose={vi.fn()} />
      </MemoryRouter>,
    );
    await settle();
    const container = document.querySelector('[data-testid="mobile-search-sheet"]') as HTMLElement;
    expect(panel()).toHaveClass('h-[62%]');
    window.dispatchEvent(Object.assign(new Event('keyboardWillShow'), { keyboardHeight: 300 }));
    await vi.waitFor(() => expect(panel()).toHaveClass('h-[85%]'));
    expect(container.style.bottom).toBe('300px');
    window.dispatchEvent(new Event('keyboardWillHide'));
    await vi.waitFor(() => expect(panel()).toHaveClass('h-[62%]'));
  });
});
