import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { SidePanel } from '@/components/chat/SidePanel';
import { EditProfileDialog } from '@/components/EditProfileDialog';
import {
  PANEL_WIDTHS_RESET_EVENT,
  SIDEBAR_WIDTH,
  SIDE_PANEL_WIDTH,
} from '@/lib/panel-width';

// Pixel-exact tests for the resizable layout panels: drag deltas map 1:1 to
// widths, clamps hold at the configured bounds, widths persist across a
// remount and profile settings resets everything.

vi.mock('@/components/SearchBar', () => ({ SearchBar: () => <input aria-label="Search" /> }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', displayName: 'Tess', email: 't@x.io', authProvider: 'oidc', systemRole: 2 },
    patchUser: vi.fn(),
  }),
}));
vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('./Sidebar', () => ({ Sidebar: () => <nav data-testid="sidebar-body">channels</nav> }));
vi.mock('./AppTopBar', () => ({ AppTopBar: () => <header data-testid="app-shell-header" /> }));
vi.mock('@/components/NotificationPermissionBanner', () => ({ NotificationPermissionBanner: () => null }));
vi.mock('@/components/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('@/hooks/useServerVersion', () => ({
  BUILD_DISPLAY_VERSION: 'browser-test',
  BUILD_VERSION: 'browser-test',
  setServerVersion: vi.fn(),
  resetServerVersionForTests: vi.fn(),
  useServerVersion: () => ({ outdated: false }),
}));

// buttons:1 = primary held, as a real pointer drag carries it. The resize
// move handler now ignores buttonless moves (so a plain hover can't resize),
// so the drag events must carry the held-button state.
function pointer(type: string, clientX: number, buttons = 1) {
  return new PointerEvent(type, { bubbles: true, clientX, pointerId: 1, button: 0, buttons });
}

function dragHandle(handle: Element, fromX: number, toX: number) {
  handle.dispatchEvent(pointer('pointerdown', fromX));
  handle.dispatchEvent(pointer('pointermove', toX));
  handle.dispatchEvent(pointer('pointerup', toX, 0));
}

let active: { unmount: () => Promise<void> } | null = null;
afterEach(async () => {
  if (active) await active.unmount();
  active = null;
});

beforeEach(() => {
  localStorage.clear();
});

async function renderLayout() {
  const result = await render(
    <MemoryRouter>
      <AppLayout>
        <div>main content</div>
      </AppLayout>
    </MemoryRouter>,
  );
  active = result;
  return result;
}

function sidebarRect() {
  return document.querySelector('[data-testid="app-sidebar"]')!.getBoundingClientRect();
}

describe('resizable sidebar (desktop)', () => {
  it('starts at the default width and follows a drag pixel for pixel', async () => {
    if (window.innerWidth < 1024) return; // persistent sidebar is lg+ only
    await renderLayout();
    expect(sidebarRect().width).toBe(SIDEBAR_WIDTH.defaultWidth);

    const handle = document.querySelector('[data-testid="sidebar-resize-handle"]')!;
    dragHandle(handle, 288, 348);
    // Continuous pointer events batch their state flush — poll the layout.
    await expect.poll(() => sidebarRect().width).toBe(SIDEBAR_WIDTH.defaultWidth + 60);
    // Persisted for the next session.
    expect(localStorage.getItem(SIDEBAR_WIDTH.key)).toBe(String(SIDEBAR_WIDTH.defaultWidth + 60));
  });

  it('clamps at both bounds', async () => {
    if (window.innerWidth < 1024) return;
    await renderLayout();
    const handle = document.querySelector('[data-testid="sidebar-resize-handle"]')!;
    dragHandle(handle, 288, 2000);
    await expect.poll(() => sidebarRect().width).toBe(SIDEBAR_WIDTH.max);
    dragHandle(handle, 400, -2000);
    await expect.poll(() => sidebarRect().width).toBe(SIDEBAR_WIDTH.min);
  });

  it('restores the persisted width on remount and resets on double-click', async () => {
    if (window.innerWidth < 1024) return;
    localStorage.setItem(SIDEBAR_WIDTH.key, '350');
    const first = await renderLayout();
    expect(sidebarRect().width).toBe(350);
    await first.unmount();
    active = null;

    await renderLayout();
    expect(sidebarRect().width).toBe(350);
    const handle = document.querySelector('[data-testid="sidebar-resize-handle"]') as HTMLElement;
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await expect.poll(() => sidebarRect().width).toBe(SIDEBAR_WIDTH.defaultWidth);
  });
});

describe('resizable side panel (desktop)', () => {
  async function renderPanel() {
    const result = await render(
      <SidePanel title="Members" ariaLabel="Members" closeLabel="Close" onClose={() => undefined}>
        <p>body</p>
      </SidePanel>,
    );
    active = result;
    return result;
  }

  function panelRect() {
    return document.querySelector('[aria-label="Members"]')!.getBoundingClientRect();
  }

  it('drags wider from its left edge (leftwards pointer = wider panel)', async () => {
    if (window.innerWidth < 768) return; // desktop rail only
    await renderPanel();
    expect(panelRect().width).toBe(SIDE_PANEL_WIDTH.defaultWidth);
    const handle = document.querySelector('[data-testid="side-panel-resize-handle"]')!;
    dragHandle(handle, 800, 740);
    await expect.poll(() => panelRect().width).toBe(SIDE_PANEL_WIDTH.defaultWidth + 60);
    dragHandle(handle, 740, 5000);
    await expect.poll(() => panelRect().width).toBe(SIDE_PANEL_WIDTH.min);
  });

  it('snaps back when the global reset event fires', async () => {
    if (window.innerWidth < 768) return;
    localStorage.setItem(SIDE_PANEL_WIDTH.key, '520');
    await renderPanel();
    expect(panelRect().width).toBe(520);
    window.dispatchEvent(new Event(PANEL_WIDTHS_RESET_EVENT));
    await expect.poll(() => panelRect().width).toBe(SIDE_PANEL_WIDTH.defaultWidth);
  });
});

describe('profile settings reset', () => {
  it('clears persisted widths, disables itself, and confirms', async () => {
    if (window.innerWidth < 768) return; // the reset row is desktop chrome
    localStorage.setItem(SIDEBAR_WIDTH.key, '350');
    localStorage.setItem(SIDE_PANEL_WIDTH.key, '520');

    const result = await render(<EditProfileDialog open onOpenChange={() => undefined} />);
    active = result;
    const btn = result.getByTestId('reset-panel-widths');
    await expect.element(btn).toBeEnabled();
    await btn.click();

    expect(localStorage.getItem(SIDEBAR_WIDTH.key)).toBeNull();
    expect(localStorage.getItem(SIDE_PANEL_WIDTH.key)).toBeNull();
    await expect.element(btn).toBeDisabled();
  });

  it('is disabled when nothing was customized', async () => {
    const result = await render(<EditProfileDialog open onOpenChange={() => undefined} />);
    active = result;
    if (window.innerWidth < 768) return;
    await expect.element(result.getByTestId('reset-panel-widths')).toBeDisabled();
  });
});
