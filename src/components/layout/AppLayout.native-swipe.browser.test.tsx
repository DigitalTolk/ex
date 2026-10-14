import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { PageContainer } from './PageContainer';
import { nativeTouchSwipe, touchScrollWorks } from '@/test/native-scroll';

// The reported bug, driven by a real finger: a slow sideways swipe over a
// scrolling conversation sprang back, because the browser claimed the touch
// as a native pan of the scroller a few pixels in and cancelled the swipe's
// pointer. Synthetic events can't show that — only genuine input goes
// through the browser's touch-action decision — so these go through CDP
// (Chromium only; the probe skips the gesture where the harness can't).

vi.mock('@/components/activity/ActivityModeSwitch', () => ({
  ActivityModeSwitch: () => <div data-testid="sidebar-mode-switch" />,
}));
vi.mock('./MobileTabBar', () => ({ MobileTabBar: () => <nav data-testid="mobile-tab-bar" /> }));
vi.mock('@/components/activity/ActivityPanel', () => ({ ActivityPanel: () => <div data-testid="activity-panel" /> }));
vi.mock('./Sidebar', () => ({ Sidebar: () => <div>Sidebar</div> }));
vi.mock('./AccountMenu', () => ({ AccountMenu: () => <div data-testid="sidebar-account" /> }));
vi.mock('./AppTopBar', () => ({ AppTopBar: () => <header data-testid="app-shell-header" /> }));
vi.mock('@/components/NotificationPermissionBanner', () => ({ NotificationPermissionBanner: () => null }));
vi.mock('./LoadingBar', () => ({ LoadingBar: () => null }));
vi.mock('@/components/UpdateBanner', () => ({ UpdateBanner: () => null }));

async function renderConversation() {
  await render(
    <MemoryRouter initialEntries={['/threads']}>
      <div style={{ height: 600 }}>
        <AppLayout>
          <PageContainer title="Threads">
            <div style={{ height: 3000 }}>Scrollable thread content</div>
          </PageContainer>
        </AppLayout>
      </div>
    </MemoryRouter>,
  );
}

const main = () => document.querySelector('[data-app-main="true"]') as HTMLElement;
const scroller = () => document.querySelector('[data-page-scroll="true"]') as HTMLElement;

describe('conversation swipe under a real finger (phone)', () => {
  it('keeps a vertical scroller inside the swipe surface pan-y', async () => {
    if (window.innerWidth > 767) return;
    await renderConversation();
    expect(getComputedStyle(main()).touchAction).toBe('pan-y');
    expect(getComputedStyle(scroller()).touchAction).toBe('pan-y');
  });

  it('a slow sideways swipe over the scrolling content reveals the list', async () => {
    if (window.innerWidth > 767) return;
    const canDrive = await touchScrollWorks();
    await renderConversation();
    if (!canDrive) return;

    const { left, top, height } = scroller().getBoundingClientRect();
    await nativeTouchSwipe(scroller(), { from: { x: left + 60, y: top + height / 2 }, dx: 200, steps: 25, stepMs: 30 });

    await vi.waitFor(() => expect(main().dataset.mobileChannelsOpen).toBe('true'));
  });

  it('a vertical drag scrolls the content and leaves the conversation where it is', async () => {
    if (window.innerWidth > 767) return;
    const canDrive = await touchScrollWorks();
    await renderConversation();
    if (!canDrive) return;

    await nativeTouchSwipe(scroller(), { dy: -200, steps: 10, stepMs: 20 });

    expect(scroller().scrollTop).toBeGreaterThan(0);
    expect(main().dataset.mobileChannelsOpen).toBe('false');
    expect(main().dataset.channelDragging).toBe('false');
  });
});
