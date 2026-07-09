import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { SidePanel } from './SidePanel';

// Browser coverage for the shared right-rail shell. Both arms of the
// data-swipe-dismissing attribute need the hook to report
// dismissing=true, which only happens mid swipe-dismiss animation. We
// drive that by mocking useSwipeDismiss — the Motion drag machinery
// itself is covered by useSwipeDismiss's own unit test.
const swipeState = vi.hoisted(() => ({ dismissing: false, settled: true }));
vi.mock('@/hooks/useSwipeDismiss', () => ({
  useSwipeDismiss: () => ({ dismissing: swipeState.dismissing, settled: swipeState.settled, motionProps: {} }),
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
  swipeState.settled = true;
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

  it('marks data-swipe-dismissing=false at rest', async () => {
    swipeState.dismissing = false;
    await renderPanel();
    const aside = document.querySelector('aside[aria-label="My panel"]') as HTMLElement;
    expect(aside.getAttribute('data-swipe-dismissing')).toBe('false');
  });

  it('marks data-swipe-dismissing=true while dismissing', async () => {
    swipeState.dismissing = true;
    await renderPanel();
    const aside = document.querySelector('aside[aria-label="My panel"]') as HTMLElement;
    expect(aside.getAttribute('data-swipe-dismissing')).toBe('true');
  });

  it('drops the left border on mobile once fully settled (not-mobile:border-l only)', async () => {
    swipeState.settled = true;
    await renderPanel();
    const aside = document.querySelector('aside[aria-label="My panel"]') as HTMLElement;
    expect(aside.className).toContain('not-mobile:border-l');
    expect(aside.className).not.toMatch(/(^|\s)border-l(\s|$)/);
  });

  it('keeps a left border on mobile while sliding in / being dragged (not settled)', async () => {
    swipeState.settled = false;
    await renderPanel();
    const aside = document.querySelector('aside[aria-label="My panel"]') as HTMLElement;
    // While the panel is still moving it carries the unprefixed border-l so
    // its edge stays separated from the content revealed behind it.
    expect(aside.className).toMatch(/(^|\s)border-l(\s|$)/);
  });
});
