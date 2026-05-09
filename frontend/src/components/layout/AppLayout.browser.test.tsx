import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppLayout } from './AppLayout';
import { Header } from './Header';
import { PageContainer } from './PageContainer';
import { SidePanel } from '@/components/chat/SidePanel';
import { expectPaintedAtCenter } from '@/test/browser-assertions';

vi.mock('@/components/SearchBar', () => ({
  SearchBar: () => <div aria-label="Search">Search</div>,
}));

vi.mock('./Sidebar', () => ({
  Sidebar: () => <div>Sidebar</div>,
}));

vi.mock('@/components/NotificationPermissionBanner', () => ({
  NotificationPermissionBanner: () => null,
}));

vi.mock('@/hooks/useServerVersion', () => ({
  BUILD_DISPLAY_VERSION: 'browser-test',
  BUILD_VERSION: 'browser-test',
  setServerVersion: vi.fn(),
  useServerVersion: () => ({ outdated: true }),
}));

const channel = {
  id: 'ch-1',
  name: 'very-long-channel-name-that-wraps-the-mobile-header',
  slug: 'very-long-channel-name-that-wraps-the-mobile-header',
  type: 'public' as const,
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-05-08T10:00:00.000Z',
};

function LayoutHarness({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/threads']}>
      <div style={{ height: 500 }}>
        <AppLayout>{children}</AppLayout>
      </div>
    </MemoryRouter>
  );
}

function touchPoint(element: Element, x: number, y: number) {
  return { identifier: 1, target: element, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
}

function dispatchTouch(element: Element, type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = type === 'touchend' ? [] : [touchPoint(element, x, y)];
  const changedTouches = [touchPoint(element, x, y)];
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'targetTouches', { value: touches });
  Object.defineProperty(event, 'changedTouches', { value: changedTouches });
  element.dispatchEvent(event);
  return event;
}

describe('AppLayout browser behavior', () => {
  it('uses a distinct light chrome color in light mode instead of dark or pure-white shell', async () => {
    document.documentElement.classList.remove('dark');

    await render(
      <LayoutHarness>
        <PageContainer title="Threads">
          <div>Thread content</div>
        </PageContainer>
      </LayoutHarness>,
    );

    const header = document.querySelector('[data-testid="app-shell-header"]') as HTMLElement | null;
    const sidebar = document.querySelector('[data-app-chrome="true"] aside, aside[data-app-chrome="true"]') as HTMLElement | null;
    expect(header).not.toBeNull();
    expect(getComputedStyle(header!).backgroundColor).not.toBe('rgb(26, 29, 33)');
    if (sidebar) {
      const sidebarBg = getComputedStyle(sidebar).backgroundColor;
      expect(sidebarBg).not.toBe('rgb(26, 29, 33)');
      expect(sidebarBg).not.toBe('rgb(255, 255, 255)');
    }
  });

  it('keeps the reload banner visible below the app header', async () => {
    const screen = await render(
      <LayoutHarness>
        <PageContainer title="Threads">
          <div style={{ height: 1200 }}>Thread content</div>
        </PageContainer>
      </LayoutHarness>,
    );

    const reload = screen.getByTestId('update-banner-reload');
    await expect.element(reload).toBeVisible();

    const appHeader = document.querySelector('[data-testid="app-shell-header"]');
    const banner = document.querySelector('[data-testid="update-banner"]') as HTMLElement | null;
    expect(appHeader).not.toBeNull();
    expect(banner).not.toBeNull();
    expect(banner!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      Math.floor(appHeader!.getBoundingClientRect().bottom),
    );
    expectPaintedAtCenter(banner!, '[data-testid="update-banner"]');
  });

  it('blurs the focused composer when mobile channel-sidebar swipe begins', async () => {
    if (window.innerWidth > 767) return;

    await render(
      <LayoutHarness>
        <input aria-label="Message input" />
      </LayoutHarness>,
    );

    const input = document.querySelector('input[aria-label="Message input"]') as HTMLInputElement | null;
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement | null;
    expect(input).not.toBeNull();
    expect(main).not.toBeNull();

    input!.focus();
    expect(document.activeElement).toBe(input);

    dispatchTouch(main!, 'touchstart', 12, 220);
    dispatchTouch(main!, 'touchmove', 92, 226);

    await vi.waitFor(() => {
      expect(document.activeElement).not.toBe(input);
      expect(main!.dataset.channelDragging).toBe('true');
    });
  });

  it('allows vertical scrolling gestures on the mobile main content', async () => {
    if (window.innerWidth > 767) return;

    await render(
      <LayoutHarness>
        <PageContainer title="Threads">
          <div style={{ height: 1600 }}>Scrollable thread content</div>
        </PageContainer>
      </LayoutHarness>,
    );

    const main = document.querySelector('[data-app-main="true"]') as HTMLElement | null;
    const scroller = document.querySelector('[data-page-scroll="true"]') as HTMLElement | null;
    expect(main).not.toBeNull();
    expect(scroller).not.toBeNull();

    dispatchTouch(main!, 'touchstart', 120, 420);
    const verticalMove = dispatchTouch(main!, 'touchmove', 122, 260);

    expect(verticalMove.defaultPrevented).toBe(false);
    expect(main!.dataset.channelDragging).toBe('false');
  });

  it('blocks page scrolling only after an intentional mobile edge swipe starts opening channels', async () => {
    if (window.innerWidth > 767) return;

    await render(
      <LayoutHarness>
        <PageContainer title="Threads">
          <div style={{ height: 1600 }}>Scrollable thread content</div>
        </PageContainer>
      </LayoutHarness>,
    );

    const main = document.querySelector('[data-app-main="true"]') as HTMLElement | null;
    expect(main).not.toBeNull();

    dispatchTouch(main!, 'touchstart', 12, 420);
    const horizontalMove = dispatchTouch(main!, 'touchmove', 96, 424);

    await vi.waitFor(() => {
      expect(horizontalMove.defaultPrevented).toBe(true);
      expect(main!.dataset.channelDragging).toBe('true');
    });
  });

  it('places mobile right panels below the measured channel header, including taller headers', async () => {
    const screen = await render(
      <LayoutHarness>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Header channel={channel} memberCount={3} canEdit onDescriptionSave={vi.fn()} />
            <div className="min-h-0 flex-1">Messages</div>
          </div>
          <SidePanel title="Pinned" ariaLabel="Pinned messages" closeLabel="Close pinned messages" onClose={vi.fn()}>
            <div>Pinned content</div>
          </SidePanel>
        </div>
      </LayoutHarness>,
    );

    if (window.innerWidth > 767) {
      await expect.element(screen.getByText('Pinned content')).toBeVisible();
      return;
    }

    await screen.getByText(channel.name).click();

    const header = document.querySelector('[data-testid="channel-header-shell"]') as HTMLElement | null;
    const panel = document.querySelector('[aria-label="Pinned messages"]') as HTMLElement | null;
    expect(header).not.toBeNull();
    expect(panel).not.toBeNull();

    await vi.waitFor(() => {
      const headerBottom = header!.getBoundingClientRect().bottom;
      const panelTop = panel!.getBoundingClientRect().top;
      const gap = panelTop - headerBottom;
      expect(gap).toBeGreaterThanOrEqual(-0.5);
      expect(gap).toBeLessThanOrEqual(1);
    });
    expectPaintedAtCenter(panel!, '[aria-label="Pinned messages"]');
  });

});
