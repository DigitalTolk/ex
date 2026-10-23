import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChatPage from '@/pages/ChatPage';
import { ConversationView } from '@/components/chat/ConversationView';
import { UnreadProvider } from '@/context/UnreadContext';
import { PresenceProvider } from '@/context/PresenceContext';
import { NotificationProvider } from '@/context/NotificationContext';
import { TypingProvider } from '@/context/TypingContext';
import type { User } from '@/types';
import { fireKeyboard, keyboardSettled } from '@/test/keyboard';
import { KeyboardInsetTracker } from '@/test/KeyboardInsetTracker';

// The phone chat with the on-screen keyboard up, end to end: the real chat
// route inside the app's keyboard-sized root (App.tsx), the real inset
// tracker, the real composer.

const authState = vi.hoisted(() => ({ user: null as User | null }));

vi.mock('@/context/AuthContext', async () => {
  const actual = await vi.importActual<typeof import('@/context/AuthContext')>('@/context/AuthContext');
  const auth = () => ({
    user: authState.user,
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    setAuth: vi.fn(),
    patchUser: vi.fn(),
  });
  return { ...actual, useAuth: auth, useOptionalAuth: auth };
});

vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }));
vi.mock('@/components/NotificationPermissionBanner', () => ({ NotificationPermissionBanner: () => null }));

const DM_ID = '01J0000000000000000000DM01';
const ME_ID = 'u-me';
const ALICE_ID = 'u-alice';
const KEYBOARD_PX = 300;
const LAST_ID = 'm-29';

function me(): User {
  return { id: ME_ID, email: 'me@example.test', displayName: 'Me', systemRole: 'member', status: 'active' } as User;
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const messages = Array.from({ length: 30 }, (_, i) => ({
  id: `m-${i}`,
  parentID: DM_ID,
  parentType: 'conversation',
  authorID: i % 2 ? ME_ID : ALICE_ID,
  body: `Message number ${i}`,
  createdAt: new Date(Date.UTC(2026, 4, 1, 10, i)).toISOString(),
}));

function installFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/auth/token/refresh')) return json({ accessToken: 't-test' });
    if (url.includes('/api/v1/version')) return json({ version: 'dev' });
    if (url.includes('/api/v1/users/me')) return json(me());
    if (url.includes('/api/v1/users/batch')) {
      return json([
        me(),
        { id: ALICE_ID, email: 'alice@example.test', displayName: 'Alice', systemRole: 'member', status: 'active' },
      ]);
    }
    if (url.endsWith('/api/v1/channels')) return json([]);
    if (url.includes('/api/v1/sidebar/categories')) return json([]);
    if (url.includes('/api/v1/drafts')) return method === 'GET' ? json([]) : new Response(null, { status: 204 });
    if (url.includes('/api/v1/user-state')) {
      return json({ channelNotifications: [], threadNotifications: [], threadSeen: {}, hiddenConversations: [] });
    }
    if (url.includes('/api/v1/threads')) return json([]);
    if (url.includes('/api/v1/emojis')) return json([]);
    if (url.includes('/api/v1/admin/settings')) return json({ maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false });
    if (url.includes('/api/v1/presence')) return json({ online: [ALICE_ID] });
    if (/\/conversations\/[^/?]+\/read$/.test(url)) return new Response(null, { status: 204 });
    if (/\/conversations\/[^/?]+\/(pinned|files)$/.test(url)) return json([]);
    if (/\/conversations\/[^/?]+\/messages$/.test(url) && method === 'POST') {
      const { body } = JSON.parse(String(init?.body)) as { body: string };
      return json({
        id: 'm-sent',
        parentID: DM_ID,
        parentType: 'conversation',
        authorID: ME_ID,
        body,
        createdAt: new Date(Date.UTC(2026, 4, 1, 11, 0)).toISOString(),
      });
    }
    if (/\/conversations\/[^/?]+\/messages(\?|$)/.test(url)) {
      // Newest first, as the API pages them.
      return json({ items: [...messages].reverse(), hasMoreOlder: false, hasMoreNewer: false, oldestID: 'm-0', newestID: LAST_ID });
    }
    if (url.endsWith(`/api/v1/conversations/${DM_ID}`)) {
      return json({ id: DM_ID, type: 'dm', participantIDs: [ME_ID, ALICE_ID], createdAt: '2026-01-01T00:00:00Z' });
    }
    if (url.includes('/api/v1/conversations')) {
      return json([{ conversationID: DM_ID, type: 'dm', displayName: 'Alice', participantIDs: [ME_ID, ALICE_ID], favorite: false, categoryID: '', unreadCount: 0 }]);
    }
    return json([]);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function renderChat() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <UnreadProvider>
        <PresenceProvider>
          <NotificationProvider>
            <TypingProvider>
              <KeyboardInsetTracker />
              <MemoryRouter initialEntries={[`/conversation/${DM_ID}`]}>
                {/* The app root, sized as in App.tsx. */}
                <div className="flex flex-col" style={{ height: 'var(--ex-app-height, 100dvh)' }}>
                  <div className="min-h-0 flex-1">
                    <Routes>
                      <Route path="/" element={<ChatPage />}>
                        <Route path="conversation/:id" element={<ConversationView />} />
                      </Route>
                    </Routes>
                  </div>
                </div>
              </MemoryRouter>
            </TypingProvider>
          </NotificationProvider>
        </PresenceProvider>
      </UnreadProvider>
    </QueryClientProvider>,
  );
}

async function frames(count: number) {
  for (let i = 0; i < count; i += 1) await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

function laidOut(selector: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>(selector)).find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) ?? null
  );
}

let restoreFetch: () => void = () => undefined;

beforeEach(() => {
  authState.user = me();
  restoreFetch = installFetch();
});

afterEach(() => {
  fireKeyboard('keyboardWillHide');
  restoreFetch();
});

// The reported bug: tapping the composer hid the newest message, and scrolling
// down to it dismissed the keyboard (useDismissKeyboardOnScroll). The app
// shrinks to the space above the keyboard and the composer opens its toolbar;
// the list must give up that height from its top, not its bottom.
// Phones only: the desktop project has no on-screen keyboard.
describe.skipIf(window.__EX_FORCE_DEVICE__ === 'desktop')('the phone chat with the keyboard up', () => {
  async function openChat() {
    renderChat();
    await vi.waitFor(() => expect(laidOut(`[data-message-id="${LAST_ID}"]`)).not.toBeNull(), { timeout: 5000 });
    const scroller = laidOut('[data-testid="virtuoso-scroller"]')!;
    await vi.waitFor(() => {
      expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBeLessThanOrEqual(2);
    }, { timeout: 3000 });
    return scroller;
  }
  // The newest message's bottom, measured from the composer's top.
  function lastAboveComposer() {
    const composer = laidOut('[data-composer-focused]')!.getBoundingClientRect();
    // `|| 0`: a sub-pixel overlap rounds to -0, which toBe(0) refuses.
    return Math.round(composer.top - laidOut(`[data-message-id="${LAST_ID}"]`)!.getBoundingClientRect().bottom) || 0;
  }
  async function raiseKeyboard() {
    laidOut('[data-message-composer] [contenteditable="true"]')!.focus();
    fireKeyboard('keyboardWillShow', KEYBOARD_PX);
    // Sitting on the keyboard, its toolbar open (it opens over 200ms).
    const onKeyboard = () =>
      (laidOut('[data-composer-focused="true"]')?.getBoundingClientRect().bottom ?? Infinity) <=
      window.innerHeight - KEYBOARD_PX + 1;
    await keyboardSettled(onKeyboard);
    await frames(3);
    expect(onKeyboard()).toBe(true);
  }

  async function lowerKeyboard() {
    (document.activeElement as HTMLElement).blur();
    fireKeyboard('keyboardWillHide');
    // The composer's toolbar closes over 200ms.
    await keyboardSettled(() => laidOut('[data-composer-focused="false"]') !== null);
    await frames(3);
  }

  it('keeps the newest message right above the composer', async () => {
    await openChat();
    expect(lastAboveComposer()).toBe(0);
    await raiseKeyboard();
    expect(lastAboveComposer()).toBe(0);
  });

  // A finger scroll seldom stops exactly at the end.
  it('keeps the newest message in view for a reader stopped a little short of the end', async () => {
    const scroller = await openChat();
    scroller.dispatchEvent(new Event('touchstart', { bubbles: true }));
    scroller.scrollTop -= 12;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await frames(3);
    expect(lastAboveComposer()).toBe(-12);
    await raiseKeyboard();
    expect(lastAboveComposer()).toBe(-12);
  });

  // Tapping into the composer and out again leaves the list as it was. With
  // less below the view than the keyboard's height, lowering the keyboard
  // used to pull the reader to the end: the taller view can't stand past the
  // content, so the browser had moved it there first.
  it('puts a reader a little way up back where they were when the keyboard goes down', async () => {
    const scroller = await openChat();
    scroller.dispatchEvent(new Event('touchstart', { bubbles: true }));
    scroller.scrollTop -= 200;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await frames(3);
    expect(lastAboveComposer()).toBe(-200);
    await raiseKeyboard();
    expect(lastAboveComposer()).toBe(-200);
    await lowerKeyboard();
    expect(lastAboveComposer()).toBe(-200);
  });

  // Sending closes the composer and the keyboard goes down: the message just
  // sent shows right above the composer, not the one before it.
  it('shows the message just sent once the keyboard is down', async () => {
    await openChat();
    await raiseKeyboard();
    await userEvent.keyboard('A new message');
    laidOut('[data-testid="schedule-send-hold"]')!.click();
    fireKeyboard('keyboardWillHide');
    await keyboardSettled(() => laidOut('[data-composer-focused="false"]') !== null);
    await frames(3);
    const sent = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]')).find((el) =>
      el.textContent?.includes('A new message'),
    );
    expect(sent).toBeDefined();
    const composer = laidOut('[data-composer-focused]')!.getBoundingClientRect();
    expect(Math.round(composer.top - sent!.getBoundingClientRect().bottom) || 0).toBe(0);
  });
});
