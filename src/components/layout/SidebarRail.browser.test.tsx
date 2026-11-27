import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarRail } from './SidebarRail';
import { apiFetch } from '@/lib/api';
import { setSidebarTheme } from '@/stores/sidebar-theme';
import { parkMouse } from '@/test/hover';

// What only a real browser can show of the rail: its width, that every
// label and badge fits and is not cut off, its colours in each sidebar
// theme, and where the bell's preview and the Do Not Disturb menu open.

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<object>()), apiFetch: vi.fn() }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'alice@example.com', displayName: 'Alice Wonder', avatarURL: '', systemRole: 'member', notificationSettings: {} },
    logout: vi.fn(),
    setAuth: vi.fn(),
  }),
}));
vi.mock('@/components/settings/SettingsDialog', () => ({ SettingsDialog: () => null }));
vi.mock('@/components/emoji/CustomEmojiDialog', () => ({ CustomEmojiDialog: () => null }));
vi.mock('@/components/UserStatusDialog', () => ({ UserStatusDialog: () => null }));
vi.mock('@/components/AboutDialog', () => ({ AboutDialog: () => null }));
vi.mock('@/components/InviteDialog', () => ({ InviteDialog: () => null }));
vi.mock('@/components/RunnersDialog', () => ({ RunnersDialog: () => null }));
vi.mock('@/hooks/useEmoji', () => ({ useEmojiMap: () => ({ data: {} }) }));

function mockApi(counts: { activity: number; threads: number; drafts: number }) {
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/activity')) return { items: [], unread: counts.activity, unreadByType: {} } as never;
    if (url === '/api/v1/user-state') {
      return {
        threadNotifications: Array.from({ length: counts.threads }, (_, i) => `t-${i}`),
        hiddenConversations: [],
        hiddenSkills: [],
      } as never;
    }
    if (url === '/api/v1/drafts') {
      return Array.from({ length: counts.drafts }, (_, i) => ({ id: `d-${i}`, gen: `g-${i}`, parentID: `ch-${i}`, body: 'hello' })) as never;
    }
    return [] as never;
  });
}

// The rail as the layout holds it: full height at the window's left edge,
// the page beside it.
function renderRail(path = '/drafts') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <div style={{ display: 'flex', height: 640 }}>
          <SidebarRail />
          <div style={{ flex: 1, minWidth: 0 }} data-testid="page" />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function paint(color: string): [number, number, number] {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

// 0 is black, 1 is white.
function luminance(el: Element, prop: 'color' | 'backgroundColor'): number {
  const [r, g, b] = paint(getComputedStyle(el)[prop]).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const wasDark = document.documentElement.classList.contains('dark');

describe('SidebarRail in the browser', () => {
  beforeEach(() => {
    // The light app: where a dark rail and a light one differ.
    document.documentElement.classList.remove('dark');
    vi.mocked(apiFetch).mockReset();
    mockApi({ activity: 4, threads: 2, drafts: 150 });
  });
  afterEach(() => {
    document.documentElement.classList.toggle('dark', wasDark);
  });

  it('is a 72px strip in which every label fits, at a readable size', async () => {
    const screen = await renderRail();
    const rail = screen.getByTestId('sidebar-rail').element();
    await expect.element(screen.getByTestId('threads-unread-badge')).toHaveTextContent('2');
    const strip = rail.getBoundingClientRect();
    expect(Math.round(strip.width)).toBe(72);
    expect(Math.round(strip.height)).toBe(640);

    const labels = Array.from(rail.querySelectorAll<HTMLElement>('a > span[aria-hidden="true"], button > span[aria-hidden="true"]'));
    expect(labels.map((label) => label.textContent)).toEqual(['Threads', 'Activity', 'Drafts', 'Directory', 'Agents& tools']);
    for (const label of labels) {
      const box = label.getBoundingClientRect();
      expect(box.left, label.textContent!).toBeGreaterThanOrEqual(strip.left);
      expect(box.right, label.textContent!).toBeLessThanOrEqual(strip.right);
      // Nothing runs wider than its box.
      expect(label.scrollWidth, label.textContent!).toBeLessThanOrEqual(label.clientWidth);
      expect(getComputedStyle(label).fontSize).toBe('12px');
    }
    // "Agents & tools" takes two lines; the others one.
    const [threads, , , , agents] = labels.map((label) => label.getBoundingClientRect().height);
    expect(agents).toBeGreaterThan(threads * 1.5);

    // Do Not Disturb sits right above the account, at the rail's foot.
    const lastStop = screen.getByTestId('sidebar-rail-agents').element().getBoundingClientRect();
    const dnd = screen.getByTestId('dnd-trigger').element().getBoundingClientRect();
    const account = screen.getByTestId('sidebar-account').element().getBoundingClientRect();
    expect(dnd.top).toBeGreaterThanOrEqual(lastStop.bottom);
    expect(account.top).toBeGreaterThanOrEqual(dnd.bottom);
    expect(Math.round(account.bottom)).toBe(Math.round(strip.bottom));
  });

  it('hangs each count off the corner of its tile, whole and inside the rail', async () => {
    const screen = await renderRail();
    const rail = screen.getByTestId('sidebar-rail').element();
    await expect.element(screen.getByTestId('threads-unread-badge')).toHaveTextContent('2');
    await expect.element(screen.getByTestId('activity-unread-badge')).toHaveTextContent('4');
    const draftsBadge = screen.getByTestId('sidebar-rail-drafts').element().querySelector<HTMLElement>('[data-slot="badge"]')!;
    expect(draftsBadge).toHaveTextContent('99+');

    const strip = rail.getBoundingClientRect();
    const badges = [screen.getByTestId('threads-unread-badge').element(), screen.getByTestId('activity-unread-badge').element(), draftsBadge];
    for (const badge of badges) {
      const name = `${badge.textContent} badge`;
      const box = badge.getBoundingClientRect();
      const tile = badge.parentElement!.getBoundingClientRect();
      // Past the tile's top right corner, still inside the rail.
      expect(box.right, name).toBeGreaterThan(tile.right);
      expect(box.top, name).toBeLessThan(tile.top);
      expect(box.right, name).toBeLessThanOrEqual(strip.right);
      expect(box.left, name).toBeGreaterThanOrEqual(strip.left);
      // Not cut off by the scrolling list of stops: each edge is hit-testable.
      const midX = box.left + box.width / 2;
      const midY = box.top + box.height / 2;
      for (const [x, y] of [
        [midX, box.top + 1],
        [midX, box.bottom - 1],
        [box.left + 1, midY],
        [box.right - 1, midY],
      ]) {
        expect(badge.contains(document.elementFromPoint(x, y)), `${name} at ${Math.round(x)},${Math.round(y)}`).toBe(true);
      }
      expect(getComputedStyle(badge).fontSize).toBe('12px');
    }
  });

  it('stays dark beside a light page, and turns light with a line to the list on request', async () => {
    const screen = await renderRail('/drafts');
    const rail = screen.getByTestId('sidebar-rail').element();
    // The stop of the page on screen: the brightest text on the rail.
    const litLabel = screen.getByTestId('sidebar-rail-drafts').element().querySelector('span[aria-hidden="true"]')!;

    expect(luminance(rail, 'backgroundColor')).toBeLessThan(0.1);
    expect(luminance(litLabel, 'color')).toBeGreaterThan(0.8);
    expect(getComputedStyle(rail).borderRightWidth).toBe('0px');

    setSidebarTheme('light');
    await expect.element(screen.getByTestId('sidebar-rail')).not.toHaveClass('dark');
    expect(luminance(rail, 'backgroundColor')).toBeGreaterThan(0.7);
    expect(luminance(litLabel, 'color')).toBeLessThan(0.1);
    expect(getComputedStyle(rail).borderRightWidth).toBe('1px');
  });

  it('keeps a dark rail in the dark app either way', async () => {
    document.documentElement.classList.add('dark');
    const screen = await renderRail('/drafts');
    const rail = screen.getByTestId('sidebar-rail').element();
    expect(luminance(rail, 'backgroundColor')).toBeLessThan(0.1);

    setSidebarTheme('light');
    await expect.element(screen.getByTestId('sidebar-rail')).not.toHaveClass('dark');
    expect(luminance(rail, 'backgroundColor')).toBeLessThan(0.1);
  });
});

describe.runIf(window.__EX_FORCE_DEVICE__ === 'desktop')('SidebarRail under a desktop mouse', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    mockApi({ activity: 0, threads: 0, drafts: 0 });
  });

  it('opens the Activity preview beside the bell while the mouse rests on it, clear of the rail', async () => {
    const screen = await renderRail('/channel/general');
    const rail = screen.getByTestId('sidebar-rail').element();
    const bell = screen.getByTestId('sidebar-mode-activity');
    await expect.element(bell).toBeVisible();
    expect(document.querySelector('[data-testid="activity-preview"]')).toBeNull();

    await userEvent.hover(bell);
    const card = screen.getByTestId('activity-preview');
    await expect.element(card).toBeVisible();
    await expect.element(screen.getByTestId('activity-preview-empty')).toHaveTextContent('No activity yet');

    // To the right of the rail, level with the bell: the stops stay in view.
    await expect
      .poll(() => card.element().getBoundingClientRect().left)
      .toBeGreaterThanOrEqual(rail.getBoundingClientRect().right);
    const bellBox = bell.element().getBoundingClientRect();
    expect(Math.abs(card.element().getBoundingClientRect().top - bellBox.top)).toBeLessThanOrEqual(1);

    // The mouse moves away: the preview goes.
    await parkMouse();
    await expect.poll(() => document.querySelector('[data-testid="activity-preview"]')).toBeNull();
  });

  it('opens the Do Not Disturb menu beside its button, inside the window', async () => {
    const screen = await renderRail('/channel/general');
    const trigger = screen.getByTestId('dnd-trigger');
    await userEvent.click(trigger);
    const state = screen.getByTestId('dnd-state');
    await expect.element(state).toBeVisible();

    // To the button's right, so it covers neither the button nor the stops.
    const menu = state.element().closest('[data-slot="dropdown-menu-content"]')!;
    await expect.poll(() => menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(trigger.element().getBoundingClientRect().right);
    const box = menu.getBoundingClientRect();
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(box.top).toBeGreaterThanOrEqual(0);
    // All five durations are listed.
    for (const id of ['dnd-30m', 'dnd-1h', 'dnd-2h', 'dnd-tomorrow', 'dnd-indefinite']) {
      await expect.element(screen.getByTestId(id)).toBeVisible();
    }
  });

  it('is wider in the macOS desktop app, so its edge clears the traffic lights', async () => {
    // The lights' last button ends 72px in: a 72px rail put its edge right
    // against the green one.
    const root = document.documentElement;
    const before = root.className;
    root.classList.add('electron-mac', 'tier-full');
    root.classList.remove('tier-compact', 'tier-mobile');
    try {
      const screen = await renderRail();
      const rail = screen.getByTestId('sidebar-rail').element();
      const strip = rail.getBoundingClientRect();
      expect(Math.round(strip.width)).toBe(88);
      // Everything still sits inside it, centred.
      const mark = screen.getByTestId('sidebar-rail-logo').element().getBoundingClientRect();
      expect(Math.round(mark.left + mark.width / 2)).toBe(Math.round(strip.left + strip.width / 2));
      for (const label of rail.querySelectorAll<HTMLElement>('a > span[aria-hidden="true"], button > span[aria-hidden="true"]')) {
        expect(label.getBoundingClientRect().right, label.textContent!).toBeLessThanOrEqual(strip.right);
        // The labels keep their size; only the stops grow.
        expect(getComputedStyle(label).fontSize).toBe('12px');
      }
      // The stops grow a little with it, so the wider rail isn't empty.
      const size = (el: Element) => Math.round(el.getBoundingClientRect().width);
      const tile = screen.getByTestId('sidebar-rail-threads').element().querySelector('[data-rail-tile]')!;
      expect(size(tile)).toBe(40);
      expect(size(tile.querySelector('svg')!)).toBe(22);
      expect(size(screen.getByTestId('dnd-trigger').element())).toBe(40);
      expect(Math.round(mark.width)).toBe(36);
      expect(size(screen.getByTestId('account-menu-trigger').element().querySelector('[data-slot="avatar"]')!)).toBe(36);
    } finally {
      root.className = before;
    }
  });
});
