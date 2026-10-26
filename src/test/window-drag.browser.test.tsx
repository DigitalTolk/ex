import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChatPage from '@/pages/ChatPage';
import { ChannelView } from '@/components/chat/ChannelView';
import { ConversationView } from '@/components/chat/ConversationView';
import ThreadsPage from '@/pages/ThreadsPage';
import DirectoriesPage from '@/pages/DirectoriesPage';
import DraftsPage from '@/pages/DraftsPage';
import { UnreadProvider } from '@/context/UnreadContext';
import { PresenceProvider } from '@/context/PresenceContext';
import { NotificationProvider } from '@/context/NotificationContext';
import { TypingProvider } from '@/context/TypingContext';
import type { User } from '@/types';

const authState = vi.hoisted(() => ({ user: null as User | null }));
vi.mock('@/context/AuthContext', async () => {
  const actual = await vi.importActual<typeof import('@/context/AuthContext')>('@/context/AuthContext');
  const auth = () => ({ user: authState.user, isAuthenticated: true, isLoading: false, login: vi.fn(), logout: vi.fn().mockResolvedValue(undefined), setAuth: vi.fn(), patchUser: vi.fn() });
  return { ...actual, useAuth: auth, useOptionalAuth: auth };
});
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }));
vi.mock('@/components/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('@/components/NotificationPermissionBanner', () => ({ NotificationPermissionBanner: () => null }));

const ME = { id: 'u-me', email: 'me@example.test', displayName: 'Me', systemRole: 'admin', status: 'active' } as User;
const ALICE = { id: 'u-alice', email: 'alice@example.test', displayName: 'Alice Example', systemRole: 'member', status: 'active' };
const CH = { id: 'ch-1', slug: 'general', name: 'general', type: 'public', description: 'Company wide', createdBy: 'u-me', createdAt: '2026-01-01T00:00:00Z', memberCount: 3 };
const DM_ID = '01J0000000000000000000DM01';
// Links and long history: rows above the view are rendered (overscan).
const msgs = Array.from({ length: 80 }, (_, i) => ({ id: `m-${i}`, parentID: 'ch-1', parentType: 'channel', authorID: i % 2 ? ME.id : ALICE.id, body: `https://example.com/page-${i} message ${i}`, reactions: { ':+1:': [ALICE.id] }, replyCount: 1, lastReplyAt: new Date(Date.UTC(2026, 4, 1, 11, i)).toISOString(), createdAt: new Date(Date.UTC(2026, 4, 1, 10, i)).toISOString() }));
const CHANNELS = Array.from({ length: 40 }, (_, i) => ({ channelID: i ? `ch-x${i}` : 'ch-1', channelName: i ? `channel-${i}` : 'general', channelType: 'public', role: 'member', slug: i ? `channel-${i}` : 'general', unreadCount: 0 }));
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });

function installFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/auth/token/refresh')) return json({ accessToken: 't' });
    if (url.includes('/api/v1/version')) return json({ version: 'dev' });
    if (url.includes('/api/v1/users/me')) return json(ME);
    if (url.includes('/api/v1/users/batch')) return json([ME, ALICE]);
    if (url.includes('/api/v1/users')) return json({ items: [ME, ALICE], nextCursor: '' });
    if (url.endsWith('/api/v1/channels')) return json(CHANNELS);
    if (url.endsWith('/api/v1/channels/general') || url.endsWith('/api/v1/channels/ch-1')) return json(CH);
    if (/\/channels\/ch-1\/messages/.test(url)) return json({ items: [...msgs].reverse(), hasMoreOlder: false, hasMoreNewer: false, oldestID: 'm-0', newestID: 'm-79' });
    if (/\/channels\/ch-1\/members/.test(url)) return json([{ userID: ME.id, role: 'owner' }, { userID: ALICE.id, role: 'member' }]);
    if (/\/channels\/ch-1\/read$/.test(url)) return new Response(null, { status: 204 });
    if (url.includes('/api/v1/channels/browse') || url.includes('/api/v1/channels?')) return json([CH]);
    if (url.includes('/api/v1/sidebar/categories')) return json([]);
    if (url.includes('/api/v1/drafts')) return method === 'GET' ? json([]) : new Response(null, { status: 204 });
    if (url.includes('/api/v1/user-state')) return json({ channelNotifications: [], threadNotifications: [], threadSeen: {}, hiddenConversations: [] });
    if (url.includes('/api/v1/threads')) return json([]);
    if (url.includes('/api/v1/emojis')) return json([]);
    if (url.includes('/api/v1/admin/settings')) return json({ maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false });
    if (url.includes('/api/v1/presence')) return json({ online: [ALICE.id] });
    if (/\/conversations\/[^/?]+\/messages/.test(url)) return json({ items: [...msgs].reverse().map((m) => ({ ...m, parentID: DM_ID, parentType: 'conversation' })), hasMoreOlder: false, hasMoreNewer: false, oldestID: 'm-0', newestID: 'm-79' });
    if (url.endsWith(`/api/v1/conversations/${DM_ID}`)) return json({ id: DM_ID, type: 'dm', participantIDs: [ME.id, ALICE.id], createdAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/v1/conversations')) return json([{ conversationID: DM_ID, type: 'dm', displayName: 'Alice Example', participantIDs: [ME.id, ALICE.id], favorite: false, categoryID: '', unreadCount: 0 }]);
    return json([]);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  // The app's root, as in index.html: everything else in the body is an
  // overlay (a dialog, a menu, a banner).
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  return render(
    <QueryClientProvider client={qc}><UnreadProvider><PresenceProvider><NotificationProvider><TypingProvider>
      <MemoryRouter initialEntries={[path]}>
        <div className="flex flex-col" style={{ height: '100dvh' }}><div className="min-h-0 flex-1">
          <Routes>
            <Route path="/" element={<ChatPage />}>
              <Route path="directory" element={<Navigate to="/directory/channels" replace />} />
              <Route path="directory/:section" element={<DirectoriesPage />} />
              <Route path="threads" element={<ThreadsPage />} />
              <Route path="drafts" element={<DraftsPage />} />
              <Route path="channel/:id" element={<ChannelView />} />
              <Route path="conversation/:id" element={<ConversationView />} />
            </Route>
          </Routes>
        </div></div>
      </MemoryRouter>
    </TypingProvider></NotificationProvider></PresenceProvider></UnreadProvider></QueryClientProvider>,
    { container: root },
  );
}


// The desktop shell's own drag rules (ex-electron src/lib/drag-region.ts),
// injected into the page as the shell does: the top bar drags, the controls
// in it don't.
const SHELL_DRAG_CSS = `
  header[data-app-chrome="true"] { -webkit-app-region: drag; }
  header[data-app-chrome="true"] :is(
    input, textarea, select, button, a,
    [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="menuitem"], [role="tab"],
    [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]
  ) { -webkit-app-region: no-drag; }
`;

// The region an element is in, inherited as in the desktop app's Chromium
// (an element with none of its own takes its parent's).
function regionOf(el: Element | null): string {
  if (!el) return 'none';
  const own = getComputedStyle(el).getPropertyValue('-webkit-app-region');
  return own === 'drag' || own === 'no-drag' ? own : regionOf(el.parentElement);
}

// Where the window can be dragged, worked out the way Electron does: every
// laid-out element in a region adds its whole box (scrolled out of sight or
// not) in page order, a later one over an earlier one.
function dragsAt(x: number, y: number): boolean {
  let drag = false;
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const region = regionOf(el);
    if (region === 'none' || getComputedStyle(el).visibility !== 'visible') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) drag = region === 'drag';
  }
  return drag;
}

let restore = () => undefined as void;
let shellCss: HTMLStyleElement | null = null;
beforeEach(() => {
  authState.user = ME;
  restore = installFetch();
  shellCss = document.createElement('style');
  shellCss.textContent = SHELL_DRAG_CSS;
  document.head.appendChild(shellCss);
});
afterEach(() => {
  restore();
  shellCss?.remove();
  document.getElementById('root')?.remove();
});

// The desktop app's window is dragged by the empty parts of the top bar and
// by the strip at the top of the sidebar — wherever the lists under them are
// scrolled to. (Only a desktop window has these.)
describe.runIf(window.__EX_FORCE_DEVICE__ === 'desktop')('dragging the desktop window', () => {
  it('drags by the top bar and the sidebar strip, over scrolled lists', async () => {
    await renderAt('/channel/general');
    await vi.waitFor(() => expect(document.querySelector('[data-message-id="m-79"]')).not.toBeNull(), { timeout: 5000 });
    const sidebarList = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="app-sidebar"] *')).find(
      (el) => el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== 'visible',
    );
    expect(sidebarList).toBeTruthy();
    sidebarList!.scrollTop = 120;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // The message list renders rows above the view, under the top bar.
    const firstRow = document.querySelector('[data-message-id]')!.getBoundingClientRect();
    const bar = document.querySelector('[data-testid="app-shell-header"]')!.getBoundingClientRect();
    expect(firstRow.top).toBeLessThan(bar.bottom);

    const strip = document.querySelector('[data-testid="sidebar-top-strip"]')!.getBoundingClientRect();
    const search = document.querySelector('[data-testid="searchbar-input"]')!.getBoundingClientRect();
    // Every few pixels of the strip, and of the bar beside the search field.
    const areas = [
      ['the sidebar strip', strip.left, strip.right, strip.top, strip.bottom],
      ['the bar left of the search field', bar.left, search.left, bar.top, bar.bottom],
      ['the bar right of the search field', search.right, bar.right, bar.top, bar.bottom],
    ] as const;
    // The bar's own buttons (Back, Forward) are for clicking.
    const controls = Array.from(document.querySelectorAll('[data-testid="app-shell-header"] button'))
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.width > 0);
    expect(controls.length).toBeGreaterThanOrEqual(2);
    const onControl = (x: number, y: number) =>
      controls.some((r) => x >= r.left - 1 && x < r.right + 1 && y >= r.top - 1 && y < r.bottom + 1);
    const holes: string[] = [];
    for (const [name, left, right, top, bottom] of areas) {
      for (let x = left + 4; x < right - 4; x += 8) {
        for (let y = top + 2; y < bottom - 2; y += 6) {
          if (!onControl(x, y) && !dragsAt(x, y)) holes.push(`${name} at ${Math.round(x)},${Math.round(y)}`);
        }
      }
    }
    expect(holes).toEqual([]);
    for (const r of controls) expect(dragsAt(r.left + r.width / 2, r.top + r.height / 2)).toBe(false);
    // The search field itself is for typing.
    expect(dragsAt(search.left + search.width / 2, search.top + search.height / 2)).toBe(false);
  });

  // What opens out of the bar or over it is for clicking, not for moving the
  // window: the search results, a notification banner.
  it('leaves the search results and a banner over the bar clickable', async () => {
    await renderAt('/channel/general');
    const input = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('[data-testid="searchbar-input"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await userEvent.click(input);
    await userEvent.keyboard('gen');
    const dropdown = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="searchbar-dropdown"]');
      expect(el).not.toBeNull();
      return el!.getBoundingClientRect();
    });
    expect(dragsAt(dropdown.left + 20, dropdown.top + 10)).toBe(false);
    expect(dragsAt(dropdown.right - 20, dropdown.bottom - 10)).toBe(false);

    // A banner drops over the top bar.
    const toastHost = document.createElement('div');
    toastHost.style.cssText = 'position:fixed;top:12px;left:0;right:0;height:56px';
    document.body.appendChild(toastHost);
    try {
      const bar = document.querySelector('[data-testid="app-shell-header"]')!.getBoundingClientRect();
      expect(dragsAt(bar.right - 20, 30)).toBe(false);
    } finally {
      toastHost.remove();
    }
  });
});
