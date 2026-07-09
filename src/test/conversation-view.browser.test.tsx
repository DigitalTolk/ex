import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChatPage from '@/pages/ChatPage';
import { ConversationView } from '@/components/chat/ConversationView';
import { UnreadProvider } from '@/context/UnreadContext';
import { PresenceProvider } from '@/context/PresenceContext';
import { NotificationProvider } from '@/context/NotificationContext';
import { TypingProvider } from '@/context/TypingContext';
import { TagSearchProvider } from '@/context/TagSearchContext';
import { resetServerVersionForTests } from '@/hooks/useServerVersion';
import { dispatchEditMessage } from '@/lib/window-events';
import type { User } from '@/types';

// REAL browser end-to-end coverage for ConversationView — the DM/group
// twin of ChannelView. Mounts the full chat route at /conversation/:id
// with a route-matched fetch stub shaped like the backend's wire format
// and drives the view's flows: DM vs group headers, intro variants,
// send/draft, pinned/files/members panels, thread deep-links and local
// threads, mobile inline editing, error pages, and the drop-to-attach
// pipeline. Mirrors src/test/channel-files-pinned.browser.test.tsx.

// Mutable auth state so individual tests can exercise the defensive
// user-null arms (userMap seeding, intro gating, dm self-fallbacks).
const authState = vi.hoisted(() => ({
  user: null as User | null,
}));

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

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('@/components/NotificationPermissionBanner', () => ({
  NotificationPermissionBanner: () => null,
}));

const DM_ID = '01J0000000000000000000DM01';
const GROUP_ID = '01J0000000000000000000GRP1';
const ME_ID = 'u-me';
const ALICE_ID = 'u-alice';
const BOB_ID = 'u-bob';
const GHOST_ID = 'u-ghost';
const ATTACHMENT_ID = '01J0000000000000000000AT01';

function meUser(): User {
  return {
    id: ME_ID,
    email: 'me@example.test',
    displayName: 'Me',
    systemRole: 'member',
    status: 'active',
  } as User;
}

function apiJSON(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function dmConv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DM_ID,
    type: 'dm',
    participantIDs: [ME_ID, ALICE_ID],
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function groupConv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GROUP_ID,
    type: 'group',
    participantIDs: [ME_ID, ALICE_ID, BOB_ID],
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function aliceMessage(convId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    parentID: convId,
    parentType: 'conversation',
    authorID: ALICE_ID,
    body: 'hello from alice',
    createdAt: '2026-05-01T11:00:00Z',
    ...overrides,
  };
}

interface FetchPlan {
  // id → Conversation wire object served from GET /conversations/:id.
  convs?: Record<string, Record<string, unknown>>;
  // Sidebar list (GET /conversations). Defaults to one row per conv.
  sidebar?: unknown[];
  // Message tail page per conversation id (defaults to []).
  messagesByConv?: Record<string, unknown[]>;
  pinned?: unknown[];
  files?: unknown[];
  attachments?: Record<string, unknown>;
  // When true the attachment-batch GET never resolves — pins the
  // "Loading message editor…" placeholder while edit attachments resolve.
  hangAttachmentBatch?: boolean;
  drafts?: unknown[];
  batchUsers?: unknown[];
  // Status for PUT /conversations/:id/read (default 204). 500 exercises
  // the swallowed-read-failure catch arm.
  readStatus?: number;
}

function installFetchStub(plan: FetchPlan = {}): () => void {
  const convs = plan.convs ?? { [DM_ID]: dmConv() };
  const sidebar =
    plan.sidebar ??
    Object.entries(convs).map(([id, c]) => ({
      conversationID: id,
      type: (c.type as string) ?? 'dm',
      displayName: (c.name as string) || `row-${id}`,
      participantIDs: c.participantIDs,
      favorite: false,
      categoryID: '',
      unreadCount: 0,
    }));
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    // Auth + bootstrap
    if (url.includes('/auth/token/refresh')) return apiJSON({ accessToken: 't-test' });
    if (url.includes('/api/v1/version')) return apiJSON({ version: 'dev' });
    if (url.includes('/api/v1/users/me')) return apiJSON(meUser());
    if (url.includes('/api/v1/users/batch')) {
      return apiJSON(plan.batchUsers ?? [
        { id: ME_ID, email: 'me@example.test', displayName: 'Me', systemRole: 'member', status: 'active' },
        { id: ALICE_ID, email: 'alice@example.test', displayName: 'Alice', avatarURL: 'https://cdn.test/alice.png', systemRole: 'member', status: 'active' },
        { id: BOB_ID, email: 'bob@example.test', displayName: 'Bob Marley', systemRole: 'member', status: 'active' },
      ]);
    }

    // Sidebar bootstrap
    if (url === '/api/v1/channels' || url.endsWith('/api/v1/channels')) return apiJSON([]);
    if (url.includes('/api/v1/sidebar/categories')) return apiJSON([]);
    if (url.endsWith('/api/v1/drafts') && method === 'PUT') return new Response(null, { status: 204 });
    if (url.includes('/api/v1/drafts')) return apiJSON(plan.drafts ?? []);
    if (url.includes('/api/v1/user-state')) {
      return apiJSON({ channelNotifications: [], threadNotifications: [], threadSeen: {}, hiddenConversations: [] });
    }
    if (url.includes('/api/v1/threads')) return apiJSON([]);
    if (url.includes('/api/v1/emojis')) return apiJSON([]);
    if (url.includes('/api/v1/admin/settings')) return apiJSON({ maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false });
    if (url.includes('/api/v1/presence')) return apiJSON({ online: [ALICE_ID] });

    // Attachment upload pipeline (drop-to-attach). alreadyExists short-
    // circuits the XHR PUT (which the fetch stub can't intercept).
    if (url.endsWith('/api/v1/attachments/url') && method === 'POST') {
      let req: { filename?: string; contentType?: string; size?: number } = {};
      try { req = JSON.parse(String(init?.body ?? '{}')) as typeof req; } catch { /* ignore */ }
      return apiJSON({
        id: 'att-up-1',
        filename: req.filename ?? 'up.bin',
        contentType: req.contentType ?? 'application/octet-stream',
        size: req.size ?? 1,
        alreadyExists: true,
      });
    }
    if (/\/api\/v1\/attachments\/[^/?]+\/process$/.test(url) && method === 'POST') {
      return new Response(null, { status: 204 });
    }
    // Batch attachment metadata (useAttachmentsBatch → GET /attachments?ids=…)
    if (url.includes('/api/v1/attachments?') && method === 'GET') {
      if (plan.hangAttachmentBatch) return new Promise<Response>(() => undefined);
      const ids = (new URL(url, 'http://x').searchParams.get('ids') ?? '').split(',').filter(Boolean);
      return apiJSON(ids.map((id) => plan.attachments?.[id]).filter(Boolean));
    }
    const attMatch = url.match(/\/api\/v1\/attachments\/([^?/]+)(\?|$)/);
    if (attMatch && method === 'GET') {
      const att = plan.attachments?.[decodeURIComponent(attMatch[1])];
      if (att) return apiJSON(att);
      return new Response('not found', { status: 404 });
    }

    // Conversation endpoints — most specific first.
    const threadMatch = url.match(/\/api\/v1\/conversations\/([^/?]+)\/messages\/([^/?]+)\/thread/);
    if (threadMatch) return apiJSON([]);
    const singleMsg = url.match(/\/api\/v1\/conversations\/([^/?]+)\/messages\/([^/?]+)$/);
    if (singleMsg && method === 'PATCH') {
      let body = '';
      try { body = (JSON.parse(String(init?.body ?? '{}')) as { body?: string }).body ?? ''; } catch { /* ignore */ }
      return apiJSON({
        id: decodeURIComponent(singleMsg[2]),
        parentID: decodeURIComponent(singleMsg[1]),
        parentType: 'conversation',
        authorID: ME_ID,
        body,
        createdAt: '2026-05-01T11:00:00Z',
        editedAt: '2026-05-01T12:30:00Z',
        attachmentIDs: [],
      });
    }
    if (singleMsg && method === 'GET') {
      const items = plan.messagesByConv?.[decodeURIComponent(singleMsg[1])] ?? [];
      const found = items.find((m) => (m as { id?: string }).id === decodeURIComponent(singleMsg[2]));
      return apiJSON(found ?? aliceMessage(decodeURIComponent(singleMsg[1]), { id: decodeURIComponent(singleMsg[2]) }));
    }
    const readMatch = url.match(/\/api\/v1\/conversations\/([^/?]+)\/read$/);
    if (readMatch && method === 'PUT') {
      return new Response(null, { status: plan.readStatus ?? 204 });
    }
    const pinnedMatch = url.match(/\/api\/v1\/conversations\/([^/?]+)\/pinned$/);
    if (pinnedMatch) return apiJSON(plan.pinned ?? []);
    const filesMatch = url.match(/\/api\/v1\/conversations\/([^/?]+)\/files$/);
    if (filesMatch) return apiJSON(plan.files ?? []);
    const msgMatch = url.match(/\/api\/v1\/conversations\/([^/?]+)\/messages(\?|$)/);
    if (msgMatch && method === 'POST') {
      let sentBody = '';
      try { sentBody = (JSON.parse(String(init?.body ?? '{}')) as { body?: string }).body ?? ''; } catch { /* ignore */ }
      return apiJSON({
        id: 'm-sent-1',
        parentID: decodeURIComponent(msgMatch[1]),
        parentType: 'conversation',
        authorID: ME_ID,
        body: sentBody,
        createdAt: '2026-05-01T12:00:00Z',
        attachmentIDs: [],
      });
    }
    if (msgMatch) {
      const items = plan.messagesByConv?.[decodeURIComponent(msgMatch[1])] ?? [];
      const firstId = (items[0] as { id?: string })?.id ?? 'm-0';
      return apiJSON({
        items,
        hasMoreOlder: false,
        hasMoreNewer: false,
        oldestID: firstId,
        newestID: firstId,
      });
    }
    const convMatch = url.match(/\/api\/v1\/conversations\/([^/?]+)$/);
    if (convMatch && method === 'GET') {
      const conv = convs[decodeURIComponent(convMatch[1])];
      if (conv) return apiJSON(conv);
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/api/v1/conversations')) return apiJSON(sidebar);

    return apiJSON([]);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
}

// Full chat route: ChatPage (sidebar + WS wiring) with the conversation
// route as its child, exactly like the real app router.
function renderRoute(initialPath: string) {
  return render(
    <QueryClientProvider client={makeQC()}>
      <UnreadProvider>
        <PresenceProvider>
          <NotificationProvider>
            <TypingProvider>
              <MemoryRouter initialEntries={[initialPath]}>
                <div style={{ height: 800, width: 1280 }}>
                  <Routes>
                    <Route path="/" element={<ChatPage />}>
                      <Route path="conversation/:id" element={<ConversationView />} />
                    </Route>
                  </Routes>
                </div>
              </MemoryRouter>
            </TypingProvider>
          </NotificationProvider>
        </PresenceProvider>
      </UnreadProvider>
    </QueryClientProvider>,
  );
}

// Bare mount without ChatPage — used for the no-id placeholder, the
// user-null defensive arms, and the active-tag right rail.
function renderBare(initialPath: string, opts: { initialTag?: string } = {}) {
  const routes = (
    <Routes>
      <Route path="/conversation" element={<ConversationView />} />
      <Route path="/conversation/:id" element={<ConversationView />} />
    </Routes>
  );
  return render(
    <QueryClientProvider client={makeQC()}>
      <UnreadProvider>
        <PresenceProvider>
          <NotificationProvider>
            <TypingProvider>
              <TagSearchProvider initialTag={opts.initialTag ?? null}>
                <MemoryRouter initialEntries={[initialPath]}>
                  <div style={{ height: 800, width: 1280 }}>{routes}</div>
                </MemoryRouter>
              </TagSearchProvider>
            </TypingProvider>
          </NotificationProvider>
        </PresenceProvider>
      </UnreadProvider>
    </QueryClientProvider>,
  );
}

// Conversations use Header's non-channel branch (no channel-title-stack
// testid) — scope to the header shell so intro-card <h2>s with the same
// name don't trip strict mode.
function headerHeading(screen: ReturnType<typeof render>, name: string) {
  // exact: role-name matching is substring by default, and several
  // assertions distinguish 'Alice' from 'Alice, Bob'.
  return screen.getByTestId('channel-header-shell').getByRole('heading', { name, exact: true });
}

function fetchCalls(): string[] {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${String(c[0])}`,
  );
}

// A drag event whose dataTransfer advertises Files — enough for
// MessageDropZone's hasFiles() and drop handler without relying on the
// DataTransfer constructor across engines.
function fileDragEvent(type: string, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files, dropEffect: '' },
  });
  return event;
}

beforeEach(() => {
  resetServerVersionForTests();
  authState.user = meUser();
});

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
});

describe('conversation route (full route, real browser)', () => {
  it('renders a 1:1 DM: peer-derived title, avatar header, intro card and messages', async () => {
    teardown = installFetchStub({
      messagesByConv: { [DM_ID]: [aliceMessage(DM_ID)] },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(headerHeading(screen, 'Alice')).toBeVisible();
    await expect.element(screen.getByText('hello from alice')).toBeVisible();
    // DM intro renders once the conversation has messages.
    await expect.element(screen.getByTestId('conversation-intro')).toBeVisible();
    // The conversation-read receipt was persisted.
    await vi.waitFor(() => {
      expect(fetchCalls().some((u) => u === `PUT /api/v1/conversations/${DM_ID}/read`)).toBe(true);
    }, { timeout: 15000 });
  });

  it('sends a new conversation message via the composer', async () => {
    teardown = installFetchStub({});
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(headerHeading(screen, 'Alice')).toBeVisible();
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    await editor.fill('a fresh dm');
    await screen.getByRole('button', { name: 'Send message' }).click();
    await vi.waitFor(() => {
      expect(fetchCalls().some((u) => u.startsWith('POST') && u.includes(`/conversations/${DM_ID}/messages`))).toBe(true);
    }, { timeout: 15000 });
  });

  it('hydrates an existing draft and flushes keystroke edits on scope switch', async () => {
    if (window.innerWidth <= 767) return; // needs the persistent desktop sidebar
    teardown = installFetchStub({
      convs: { [DM_ID]: dmConv(), [GROUP_ID]: groupConv() },
      drafts: [
        { id: 'draft-1', parentID: DM_ID, parentType: 'conversation', parentMessageID: '', body: 'half-written', attachmentIDs: [], updatedAt: '2026-05-01T11:00:00Z', gen: 'g-1' },
      ],
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    const editor = screen.getByLabelText('Message input');
    await vi.waitFor(() => {
      expect(editor.element().textContent ?? '').toContain('half-written');
    }, { timeout: 15000 });
    await editor.click();
    await editor.fill('half-written plus more');
    // Debounced keystroke save persists silently.
    await vi.waitFor(() => {
      expect(fetchCalls().filter((u) => u === 'PUT /api/v1/drafts').length).toBeGreaterThan(0);
    }, { timeout: 15000 });
    const before = fetchCalls().filter((u) => u === 'PUT /api/v1/drafts').length;
    // Switching conversations flushes the draft with notify (sidebar surfacing).
    await screen.getByTestId(`conversation-row-${GROUP_ID}`).getByRole('link').click();
    await expect.element(headerHeading(screen, 'Alice, Bob')).toBeVisible();
    await vi.waitFor(() => {
      expect(fetchCalls().filter((u) => u === 'PUT /api/v1/drafts').length).toBeGreaterThan(before);
    }, { timeout: 15000 });
  });

  it('renders a group: first-name title and member list toggle (incl. unresolved member)', async () => {
    teardown = installFetchStub({
      convs: { [GROUP_ID]: groupConv({ participantIDs: [ME_ID, ALICE_ID, BOB_ID, GHOST_ID] }) },
      messagesByConv: { [GROUP_ID]: [aliceMessage(GROUP_ID)] },
    });
    const screen = await renderRoute(`/conversation/${GROUP_ID}`);
    // Ghost has no batch-user entry → filtered from the title, "Unknown" in the list.
    await expect.element(headerHeading(screen, 'Alice, Bob')).toBeVisible();
    await expect.element(screen.getByTestId('conversation-intro')).toBeVisible();
    await screen.getByLabelText('Toggle member list').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="member-list-scroll-area"]')).not.toBeNull();
      expect(document.querySelector(`[data-testid="member-name-status-${GHOST_ID}"]`)?.textContent ?? '').toContain('Unknown');
    }, { timeout: 15000 });
    // Toggling again closes the panel.
    await screen.getByLabelText('Toggle member list').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="member-list-scroll-area"]')).toBeNull();
    }, { timeout: 15000 });
  });

  it('drops the members panel when switching from a group to a DM', async () => {
    if (window.innerWidth <= 767) return; // needs the persistent desktop sidebar
    teardown = installFetchStub({
      convs: { [GROUP_ID]: groupConv(), [DM_ID]: dmConv() },
    });
    const screen = await renderRoute(`/conversation/${GROUP_ID}`);
    await expect.element(headerHeading(screen, 'Alice, Bob')).toBeVisible();
    await screen.getByLabelText('Toggle member list').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="member-list-scroll-area"]')).not.toBeNull();
    }, { timeout: 15000 });
    // Navigate to the DM — the members panel must not survive on a
    // conversation type that has no member list.
    await screen.getByTestId(`conversation-row-${DM_ID}`).getByRole('link').click();
    await expect.element(headerHeading(screen, 'Alice')).toBeVisible();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="member-list-scroll-area"]')).toBeNull();
    }, { timeout: 15000 });
  });

  it('populates the PINNED panel from /conversations/:id/pinned and toggles it closed', async () => {
    teardown = installFetchStub({
      pinned: [
        {
          id: 'pin-1',
          parentID: DM_ID,
          parentType: 'conversation',
          authorID: ALICE_ID,
          body: 'remember the plan',
          createdAt: '2026-05-01T11:00:00Z',
          pinned: true,
          pinnedAt: '2026-05-01T11:30:00Z',
          pinnedBy: ME_ID,
        },
      ],
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(headerHeading(screen, 'Alice')).toBeVisible();
    await screen.getByTestId('pinned-toggle').click();
    await expect.element(screen.getByRole('heading', { name: 'Pinned messages' })).toBeVisible();
    await expect.element(screen.getByText('remember the plan')).toBeVisible();
    await screen.getByTestId('pinned-toggle').click();
    await vi.waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Pinned messages' }).query()).toBeNull();
    }, { timeout: 15000 });
  });

  it('populates the FILES panel from /conversations/:id/files + attachment metadata', async () => {
    teardown = installFetchStub({
      files: [
        { attachmentID: ATTACHMENT_ID, messageID: 'm-1', authorID: ALICE_ID, createdAt: '2026-05-01T11:00:00Z' },
      ],
      attachments: {
        [ATTACHMENT_ID]: {
          id: ATTACHMENT_ID,
          filename: 'spec.pdf',
          contentType: 'application/pdf',
          size: 12345,
          url: 'https://cdn.test/spec.pdf',
          downloadURL: 'https://cdn.test/spec.pdf?dl=1',
        },
      },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(headerHeading(screen, 'Alice')).toBeVisible();
    await screen.getByTestId('files-toggle').click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="files-row"]').length).toBe(1);
    }, { timeout: 15000 });
    await expect.element(screen.getByTestId('files-row-open').getByText('spec.pdf')).toBeVisible();
  });

  it('opens the thread panel from a ?thread= deep link and dismisses it without stripping the URL', async () => {
    teardown = installFetchStub({
      messagesByConv: { [DM_ID]: [aliceMessage(DM_ID)] },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}?thread=m-1`);
    await expect.element(headerHeading(screen, 'Alice')).toBeVisible();
    await expect.element(screen.getByRole('heading', { name: 'Thread' })).toBeVisible();
    // The deep-linked thread is marked seen.
    await vi.waitFor(() => {
      expect(fetchCalls().some((u) => u.includes(`/user-state/threads/conversations/${DM_ID}/m-1/seen`))).toBe(true);
    }, { timeout: 15000 });
    await screen.getByRole('button', { name: 'Close thread' }).click();
    await vi.waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Thread' }).query()).toBeNull();
    }, { timeout: 15000 });
    // The dismissal is local — the header (and URL-driven state) stay put.
    await expect.element(headerHeading(screen, 'Alice')).toBeVisible();
  });

  it('expires a thread dismissal on the next navigation (navKey-keyed)', async () => {
    if (window.innerWidth <= 767) return; // needs the persistent desktop sidebar
    teardown = installFetchStub({
      messagesByConv: { [DM_ID]: [aliceMessage(DM_ID)] },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}?thread=m-1`);
    await expect.element(screen.getByRole('heading', { name: 'Thread' })).toBeVisible();
    await screen.getByRole('button', { name: 'Close thread' }).click();
    await vi.waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Thread' }).query()).toBeNull();
    }, { timeout: 15000 });
    // A fresh navigation (no ?thread=) mints a new navKey; the stale
    // dismissal no longer matches and simply ages out.
    await screen.getByTestId(`conversation-row-${DM_ID}`).getByRole('link').click();
    await expect.element(headerHeading(screen, 'Alice')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Thread' }).query()).toBeNull();
  });

  it('opens a thread locally from the message toolbar and closes it', async () => {
    if (window.innerWidth <= 767) return; // desktop hover toolbar
    teardown = installFetchStub({
      messagesByConv: { [DM_ID]: [aliceMessage(DM_ID)] },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByText('hello from alice')).toBeVisible();
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Reply in thread"]')).not.toBeNull();
    }, { timeout: 15000 });
    (document.querySelector('[aria-label="Reply in thread"]') as HTMLElement).click();
    await expect.element(screen.getByRole('heading', { name: 'Thread' })).toBeVisible();
    // Closing a locally-opened thread (no ?thread= in the URL) just clears it.
    await screen.getByRole('button', { name: 'Close thread' }).click();
    await vi.waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Thread' }).query()).toBeNull();
    }, { timeout: 15000 });
  });

  it('shows the TagSearchPanel in the right rail when a tag is active', async () => {
    teardown = installFetchStub({});
    const screen = await renderBare(`/conversation/${DM_ID}`, { initialTag: 'urgent' });
    await expect.element(headerHeading(screen, 'Alice')).toBeVisible();
    await vi.waitFor(() => {
      expect(document.body.textContent ?? '').toContain('urgent');
    }, { timeout: 15000 });
  });

  it('routes dropped files into the composer upload pipeline', async () => {
    teardown = installFetchStub({
      messagesByConv: { [DM_ID]: [aliceMessage(DM_ID)] },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByText('hello from alice')).toBeVisible();
    const target = screen.getByText('hello from alice').element() as HTMLElement;
    const file = new File(['x'], 'drop.png', { type: 'image/png' });
    target.dispatchEvent(fileDragEvent('dragenter', [file]));
    target.dispatchEvent(fileDragEvent('drop', [file]));
    await vi.waitFor(() => {
      expect(fetchCalls().some((u) => u.startsWith('POST') && u.includes('/attachments/url'))).toBe(true);
    }, { timeout: 15000 });
  });
});

describe('conversation title + intro fallbacks', () => {
  it('falls back to the conversation name when the DM peer never resolves (read failure swallowed)', async () => {
    teardown = installFetchStub({
      convs: { [DM_ID]: dmConv({ participantIDs: [ME_ID, GHOST_ID], name: 'Old Pal' }) },
      messagesByConv: { [DM_ID]: [aliceMessage(DM_ID, { authorID: GHOST_ID, body: 'ghost says hi' })] },
      readStatus: 500,
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(headerHeading(screen, 'Old Pal')).toBeVisible();
    // The intro can't resolve the peer either → Unknown.
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="conversation-intro"]')?.textContent ?? '').toContain('Unknown');
    }, { timeout: 15000 });
  });

  it('falls back to "Direct Message" when the DM peer never resolves and no name is set', async () => {
    teardown = installFetchStub({
      convs: { [DM_ID]: dmConv({ participantIDs: [ME_ID, GHOST_ID] }) },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(headerHeading(screen, 'Direct Message')).toBeVisible();
  });

  it('renders the self-DM intro and own title for a conversation without participants', async () => {
    // No participantIDs at all — legacy self-DM rows omit the field.
    teardown = installFetchStub({
      convs: { [DM_ID]: dmConv({ participantIDs: undefined }) },
      messagesByConv: {
        [DM_ID]: [aliceMessage(DM_ID, { authorID: ME_ID, body: 'note to self' })],
      },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(headerHeading(screen, 'Me')).toBeVisible();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="conversation-intro"]')?.textContent ?? '').toContain('Me');
    }, { timeout: 15000 });
  });

  it('derives the header without an authenticated user (defensive arms)', async () => {
    authState.user = null;
    teardown = installFetchStub({
      convs: { [DM_ID]: dmConv({ participantIDs: [], name: 'Named DM' }) },
      messagesByConv: { [DM_ID]: [aliceMessage(DM_ID)] },
    });
    const screen = await renderBare(`/conversation/${DM_ID}`);
    await expect.element(headerHeading(screen, 'Named DM')).toBeVisible();
    // No user → no intro card even though messages exist.
    expect(document.querySelector('[data-testid="conversation-intro"]')).toBeNull();
  });

  it('falls back to "Direct Message" without a user or a conversation name', async () => {
    authState.user = null;
    teardown = installFetchStub({
      convs: { [DM_ID]: dmConv({ participantIDs: [] }) },
    });
    const screen = await renderBare(`/conversation/${DM_ID}`);
    // "Direct Message" is ALSO the pre-load placeholder title — wait for
    // the DM avatar (rendered only once conversation.type resolves) so the
    // assertion pins the derived title, not the loading fallback.
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="channel-header-shell"] [data-slot="avatar"]')).not.toBeNull();
    }, { timeout: 15000 });
    await expect.element(headerHeading(screen, 'Direct Message')).toBeVisible();
  });

  it('renders a group without participantIDs via the fallback title and an empty intro', async () => {
    teardown = installFetchStub({
      convs: { [GROUP_ID]: groupConv({ participantIDs: undefined, name: '' }) },
      messagesByConv: { [GROUP_ID]: [aliceMessage(GROUP_ID)] },
    });
    const screen = await renderRoute(`/conversation/${GROUP_ID}`);
    await expect.element(headerHeading(screen, 'Direct Message')).toBeVisible();
    await expect.element(screen.getByTestId('conversation-intro')).toBeVisible();
  });

  it('falls back to the conversation name for an unknown conversation type', async () => {
    teardown = installFetchStub({
      convs: { [DM_ID]: { id: DM_ID, type: 'broadcast', name: 'Legacy', participantIDs: [ME_ID, ALICE_ID], createdAt: '2026-01-01T00:00:00Z' } },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(headerHeading(screen, 'Legacy')).toBeVisible();
  });

  it('maps batch users with blank display names to "Unknown"', async () => {
    teardown = installFetchStub({
      batchUsers: [
        { id: ME_ID, email: 'me@example.test', displayName: 'Me', systemRole: 'member', status: 'active' },
        { id: ALICE_ID, email: 'alice@example.test', displayName: '', systemRole: 'member', status: 'active' },
      ],
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(headerHeading(screen, 'Unknown')).toBeVisible();
  });
});

describe('conversation error + placeholder pages', () => {
  it('shows the placeholder when there is no conversation id in the route', async () => {
    teardown = installFetchStub({});
    // The stray ?thread= exercises the thread-seen guard without an id.
    const screen = await renderBare('/conversation?thread=m-9');
    await expect.element(screen.getByText(/select a conversation/i)).toBeVisible();
  });

  it('renders the 404 page when the conversation fetch returns 404', async () => {
    teardown = installFetchStub({ convs: {} });
    const screen = await renderRoute('/conversation/ghost-conv');
    await expect.element(screen.getByTestId('not-found-page')).toBeVisible();
    expect(screen.getByTestId('not-found-page').element().textContent).toContain('Conversation not found');
  });

  it('renders the 403 access-denied page', async () => {
    const inner = installFetchStub({});
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/\/api\/v1\/conversations\/[^/?]+$/.test(url) && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      return base(input, init);
    }) as typeof fetch;
    teardown = () => { inner(); };
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByTestId('resource-error-403')).toBeVisible();
  });

  it('renders the 500 error page for a server error with a status', async () => {
    const inner = installFetchStub({});
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/\/api\/v1\/conversations\/[^/?]+$/.test(url) && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      return base(input, init);
    }) as typeof fetch;
    teardown = () => { inner(); };
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByTestId('resource-error-500')).toBeVisible();
  });

  it('renders the 500 page when the conversation request fails without an HTTP status', async () => {
    const inner = installFetchStub({});
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/\/api\/v1\/conversations\/[^/?]+$/.test(url) && (init?.method ?? 'GET') === 'GET') {
        throw new Error('connection reset');
      }
      return base(input, init);
    }) as typeof fetch;
    teardown = () => { inner(); };
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByTestId('resource-error-500')).toBeVisible();
  });

  it('renders the 500 page for a non-object query rejection', async () => {
    const inner = installFetchStub({});
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/\/api\/v1\/conversations\/[^/?]+$/.test(url) && (init?.method ?? 'GET') === 'GET') {
        // Deliberately reject with a primitive to exercise errorStatus's
        // typeof guard (a non-object rejection reaching React Query).
        return Promise.reject('conversation exploded');
      }
      return base(input, init);
    }) as typeof fetch;
    teardown = () => { inner(); };
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByTestId('resource-error-500')).toBeVisible();
  });

  it('renders the 500 page when the conversation resolves empty', async () => {
    const inner = installFetchStub({});
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/\/api\/v1\/conversations\/[^/?]+$/.test(url) && (init?.method ?? 'GET') === 'GET') {
        return apiJSON(null);
      }
      return base(input, init);
    }) as typeof fetch;
    teardown = () => { inner(); };
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByTestId('resource-error-500')).toBeVisible();
  });
});

describe('mobile inline editing (conversation composer)', () => {
  it('enters the mobile inline editor for an own message and cancels', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      messagesByConv: {
        [DM_ID]: [aliceMessage(DM_ID, { id: 'own-1', authorID: ME_ID, body: 'my own message' })],
      },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByText('my own message')).toBeVisible();
    dispatchEditMessage({ messageId: 'own-1' });
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await screen.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(screen.getByRole('button', { name: 'Send message' })).toBeVisible();
  });

  it('saves an edited own message via the mobile composer (changed body → PATCH)', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      messagesByConv: {
        [DM_ID]: [aliceMessage(DM_ID, { id: 'own-2', authorID: ME_ID, body: 'before edit' })],
      },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByText('before edit')).toBeVisible();
    dispatchEditMessage({ messageId: 'own-2' });
    const editor = screen.getByLabelText('Message input');
    await expect.element(editor).toBeVisible();
    await editor.click();
    await editor.fill('after edit');
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      expect(fetchCalls().some((u) => u.startsWith('PATCH') && u.includes(`/conversations/${DM_ID}/messages/own-2`))).toBe(true);
    }, { timeout: 15000 });
    // onSuccess closes the editor.
    await expect.element(screen.getByRole('button', { name: 'Send message' })).toBeVisible();
  });

  it('closes the mobile editor without a PATCH when nothing changed (incl. attachment list)', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      attachments: {
        [ATTACHMENT_ID]: { id: ATTACHMENT_ID, filename: 'same.png', contentType: 'image/png', size: 128 },
      },
      messagesByConv: {
        [DM_ID]: [aliceMessage(DM_ID, { id: 'own-same', authorID: ME_ID, body: 'keep me as is', attachmentIDs: [ATTACHMENT_ID] })],
      },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByText('keep me as is')).toBeVisible();
    dispatchEditMessage({ messageId: 'own-same' });
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    // Wait for the attachment chip so Save compares the REAL attachment
    // list (per-id equality), not a still-loading empty one.
    await vi.waitFor(() => {
      expect(document.body.textContent ?? '').toContain('same.png');
    }, { timeout: 15000 });
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('button', { name: 'Send message' })).toBeVisible();
    expect(fetchCalls().some((u) => u.startsWith('PATCH') && u.includes('/messages/own-same'))).toBe(false);
  });

  it('saves a blanked body when the edit still carries an attachment', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      attachments: {
        [ATTACHMENT_ID]: { id: ATTACHMENT_ID, filename: 'keeper.png', contentType: 'image/png', size: 128 },
      },
      messagesByConv: {
        [DM_ID]: [aliceMessage(DM_ID, { id: 'own-blank', authorID: ME_ID, body: 'text to clear', attachmentIDs: [ATTACHMENT_ID] })],
      },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByText('text to clear')).toBeVisible();
    dispatchEditMessage({ messageId: 'own-blank' });
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    await vi.waitFor(() => {
      expect(document.body.textContent ?? '').toContain('keeper.png');
    }, { timeout: 15000 });
    // Clearing the text is a real change (the attachment keeps the message
    // non-empty, so this is NOT the blank-edit close path) → PATCH fires.
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    await editor.fill('');
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      expect(fetchCalls().some((u) => u.startsWith('PATCH') && u.includes(`/conversations/${DM_ID}/messages/own-blank`))).toBe(true);
    }, { timeout: 15000 });
  });

  it('holds the composer behind "Loading message editor…" while edit attachments resolve, and ignores drops meanwhile', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      hangAttachmentBatch: true,
      messagesByConv: {
        [DM_ID]: [aliceMessage(DM_ID, { id: 'own-loading', authorID: ME_ID, body: 'own with file', attachmentIDs: [ATTACHMENT_ID] })],
      },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByText('own with file')).toBeVisible();
    dispatchEditMessage({ messageId: 'own-loading' });
    await expect.element(screen.getByText('Loading message editor…')).toBeVisible();
    // The composer is unmounted while loading — a drop has no input to
    // route into and must be a harmless no-op.
    const target = screen.getByText('Loading message editor…').element() as HTMLElement;
    const file = new File(['x'], 'late.png', { type: 'image/png' });
    target.dispatchEvent(fileDragEvent('dragenter', [file]));
    target.dispatchEvent(fileDragEvent('drop', [file]));
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchCalls().some((u) => u.startsWith('POST') && u.includes('/attachments/url'))).toBe(false);
    await expect.element(screen.getByText('Loading message editor…')).toBeVisible();
  });

  it('loads resolvable edit attachments into the mobile composer and drops ghost ids', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      attachments: {
        [ATTACHMENT_ID]: {
          id: ATTACHMENT_ID,
          filename: 'edit-me.png',
          contentType: 'image/png',
          size: 4096,
          url: 'https://cdn.test/edit-me.png',
          squareThumbnailURL: 'https://cdn.test/edit-me-sq.png',
        },
      },
      messagesByConv: {
        [DM_ID]: [aliceMessage(DM_ID, { id: 'own-ghost', authorID: ME_ID, body: 'partial attachments', attachmentIDs: [ATTACHMENT_ID, 'att-gone'] })],
      },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByText('partial attachments')).toBeVisible();
    dispatchEditMessage({ messageId: 'own-ghost' });
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    await vi.waitFor(() => {
      expect(document.body.textContent ?? '').toContain('edit-me.png');
    }, { timeout: 15000 });
    expect(document.body.textContent).not.toContain('att-gone');
  });

  it('loads an edit attachment lacking url/thumbnail into the mobile composer', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      attachments: {
        [ATTACHMENT_ID]: { id: ATTACHMENT_ID, filename: 'bare.bin', contentType: 'application/octet-stream', size: 256 },
      },
      messagesByConv: {
        [DM_ID]: [aliceMessage(DM_ID, { id: 'own-bare', authorID: ME_ID, body: 'bare attachment', attachmentIDs: [ATTACHMENT_ID] })],
      },
    });
    const screen = await renderRoute(`/conversation/${DM_ID}`);
    await expect.element(screen.getByText('bare attachment')).toBeVisible();
    dispatchEditMessage({ messageId: 'own-bare' });
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    await vi.waitFor(() => {
      expect(document.body.textContent ?? '').toContain('bare.bin');
    }, { timeout: 15000 });
  });
});
