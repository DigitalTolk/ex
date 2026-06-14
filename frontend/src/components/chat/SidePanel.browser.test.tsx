import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { SidePanel } from './SidePanel';

// Browser coverage for the shared right-rail shell. Both arms of the
// `dismissing ? 'max-md:translate-x-full' : ''` className ternary and
// the data-swipe-dismissing attribute (lines 21, 24) need the hook to
// report dismissing=true, which only happens mid swipe-dismiss
// animation. We drive that by mocking useAnimatedSwipeDismiss — the
// gesture machinery itself is covered by useAnimatedSwipeDismiss.browser.test.
const swipeState = vi.hoisted(() => ({ dismissing: false }));
vi.mock('@/hooks/useAnimatedSwipeDismiss', () => ({
  useAnimatedSwipeDismiss: () => ({
    dismissing: swipeState.dismissing,
    dragOffset: 0,
    dragStyle: undefined,
    swipeHandlers: {},
  }),
}));

let active: { unmount: () => Promise<void> | void } | null = null;

beforeEach(() => {
  // Kill animations so Radix-style exit transitions resolve synchronously
  // and stale portals/asides don't outlive the test on WebKit.
  const style = document.createElement('style');
  style.id = 'kill-anim';
  style.textContent = '*{animation:none!important;transition:none!important}';
  document.head.appendChild(style);
});

afterEach(async () => {
  if (active) await active.unmount();
  active = null;
  swipeState.dismissing = false;
  document.getElementById('kill-anim')?.remove();
});

async function renderPanel(onClose = vi.fn()) {
  const result = await render(
    <SidePanel title="My Panel" ariaLabel="My panel" closeLabel="Close my panel" onClose={onClose}>
      <p>panel body</p>
    </SidePanel>,
  );
  active = result;
  return result;
}

describe('SidePanel browser behaviour', () => {
  it('renders the title, body, and close button', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByText('My Panel')).toBeVisible();
    await expect.element(screen.getByText('panel body')).toBeVisible();
    await expect.element(screen.getByLabelText('Close my panel')).toBeVisible();
  });

  it('invokes onClose from the close button', async () => {
    const onClose = vi.fn();
    const screen = await renderPanel(onClose);
    await screen.getByLabelText('Close my panel').click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('marks data-swipe-dismissing=false and omits the slide-out class at rest', async () => {
    swipeState.dismissing = false;
    await renderPanel();
    const aside = document.querySelector('aside[aria-label="My panel"]') as HTMLElement;
    expect(aside.getAttribute('data-swipe-dismissing')).toBe('false');
    expect(aside.className).not.toContain('max-md:translate-x-full');
  });

  it('applies the slide-out class and data-swipe-dismissing=true while dismissing', async () => {
    // dismissing=true → the truthy arms of both ternaries (lines 21, 24).
    swipeState.dismissing = true;
    await renderPanel();
    const aside = document.querySelector('aside[aria-label="My panel"]') as HTMLElement;
    expect(aside.getAttribute('data-swipe-dismissing')).toBe('true');
    expect(aside.className).toContain('max-md:translate-x-full');
  });
});
