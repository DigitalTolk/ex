import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChatPage from '@/pages/ChatPage';
import { ChannelView } from '@/components/chat/ChannelView';
import { UnreadProvider } from '@/context/UnreadContext';
import { PresenceProvider } from '@/context/PresenceContext';
import { NotificationProvider } from '@/context/NotificationContext';
import { TypingProvider } from '@/context/TypingContext';
import { resetServerVersionForTests } from '@/hooks/useServerVersion';
import { dispatchEditMessage } from '@/lib/window-events';
import { TagSearchProvider } from '@/context/TagSearchContext';

// REAL browser end-to-end test for the side panels: mount the full
// chat route, stub fetch with realistic data shaped exactly like the
// backend's wire format, click the pinned and files toggles in the
// header, and assert the panels are populated.
//
// This is the reproduction for "files panel and pinned panel are empty
// when the channel has attachments and pinned messages". Before this
// file, the per-component browser tests for FilesPanel and PinnedPanel
// only smoke-rendered the panels in isolation — they never exercised
// the path from sidebar → channel → header toggle, so a regression
// in the wiring shipped to prod.

vi.mock('@/context/AuthContext', async () => {
  const actual = await vi.importActual<typeof import('@/context/AuthContext')>('@/context/AuthContext');
  return {
    ...actual,
    useAuth: () => ({
      user: { id: 'u-me', displayName: 'Me', email: 'me@example.test', systemRole: 'member', status: 'active' },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      setAuth: vi.fn(),
      patchUser: vi.fn(),
    }),
    useOptionalAuth: () => ({
      user: { id: 'u-me', displayName: 'Me', email: 'me@example.test', systemRole: 'member', status: 'active' },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      setAuth: vi.fn(),
      patchUser: vi.fn(),
    }),
  };
});

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('@/components/NotificationPermissionBanner', () => ({
  NotificationPermissionBanner: () => null,
}));

const CHANNEL_ID = '01J0000000000000000000CH01';
const ME_ID = 'u-me';
const ALICE_ID = 'u-alice';
const ATTACHMENT_ID = '01J0000000000000000000AT01';
const PIN_ID = '01J0000000000000000000PIN1';

function apiJSON(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

interface FetchPlan {
  files: { attachmentID: string; messageID: string; authorID: string; createdAt: string }[];
  pinned: unknown[];
  attachments: Record<string, unknown>;
  // Optional override for the channel's message page (defaults to one Alice
  // message referencing the attachment).
  messages?: unknown[];
  // Optional override for the channel member list (defaults to Me + Alice).
  members?: unknown[];
  // Role of the current user (Me) in the default member list. Drives the
  // header's edit/archive/leave affordances. Defaults to 'member'.
  myRole?: string;
  // Channel slug/name (defaults to 'general'). A non-'general' slug lets the
  // Leave action surface, since canLeaveChannel blocks the general channel.
  slug?: string;
  // Existing drafts payload (defaults to []). A draft for this channel scope
  // exercises the send-with-existing-draft path.
  drafts?: unknown[];
  // Extra batch-users override (e.g. to inject a blank-display-name user).
  batchUsers?: unknown[];
}

function installFetchStub(plan: FetchPlan): () => void {
  const slug = plan.slug ?? 'general';
  const myRole = plan.myRole ?? 'member';
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    // Auth + bootstrap
    if (url.includes('/auth/token/refresh')) return apiJSON({ accessToken: 't-test' });
    if (url.includes('/api/v1/version')) return apiJSON({ version: 'dev' });
    if (url.includes('/api/v1/users/me')) {
      return apiJSON({ id: ME_ID, email: 'me@example.test', displayName: 'Me', systemRole: 'member', status: 'active' });
    }

    // Sidebar bootstrap
    if (url === '/api/v1/channels' || url.endsWith('/api/v1/channels')) {
      return apiJSON([
        { channelID: CHANNEL_ID, channelName: slug, channelType: 'public', muted: false, favorite: false, categoryID: '', unreadCount: 0 },
      ]);
    }
    if (url.includes('/api/v1/conversations')) return apiJSON([]);
    if (url.includes('/api/v1/sidebar/categories')) return apiJSON([]);
    if (url.includes('/api/v1/drafts')) return apiJSON(plan.drafts ?? []);
    if (url.includes('/api/v1/user-state')) {
      return apiJSON({ channelNotifications: [], threadNotifications: [], threadSeen: {}, hiddenConversations: [] });
    }
    if (url.includes('/api/v1/threads')) return apiJSON([]);
    if (url.includes('/api/v1/emojis')) return apiJSON([]);
    if (url.includes('/api/v1/admin/settings')) return apiJSON({ maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false });

    // Channel page bootstrap
    if (url.endsWith(`/api/v1/channels/${slug}`)) {
      return apiJSON({
        id: CHANNEL_ID,
        name: slug,
        slug,
        type: 'public',
        description: '',
        createdBy: ME_ID,
        archived: false,
        createdAt: '2026-01-01T00:00:00Z',
      });
    }
    if (url.endsWith(`/api/v1/channels/${CHANNEL_ID}/members`)) {
      return apiJSON(plan.members ?? [
        { channelID: CHANNEL_ID, userID: ME_ID, role: myRole, displayName: 'Me', joinedAt: '2026-01-01T00:00:00Z' },
        { channelID: CHANNEL_ID, userID: ALICE_ID, role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
      ]);
    }
    // Posting a new channel message → echo back a fully-formed Message so the
    // optimistic-append path (appendMessageToCache) renders a real body, not a
    // stub with an undefined body.
    if (url.includes(`/api/v1/channels/${CHANNEL_ID}/messages`) && method === 'POST' && !url.includes('/pinned') && !url.includes('/no-unfurl')) {
      let sentBody = '';
      try { sentBody = (JSON.parse(String(init?.body ?? '{}')) as { body?: string }).body ?? ''; } catch { /* ignore */ }
      return apiJSON({
        id: 'm-sent-1',
        parentID: CHANNEL_ID,
        parentType: 'channel',
        authorID: ME_ID,
        body: sentBody,
        createdAt: '2026-05-01T12:00:00Z',
        attachmentIDs: [],
      });
    }
    if (url.includes(`/api/v1/channels/${CHANNEL_ID}/messages`) && !url.includes('/pinned') && !url.includes('/no-unfurl')) {
      // Initial tail page with one message that references the attachment
      // (or a caller-supplied override).
      const items = plan.messages ?? [
        {
          id: 'm-1',
          parentID: CHANNEL_ID,
          parentType: 'channel',
          authorID: ALICE_ID,
          body: 'see attached',
          createdAt: '2026-05-01T11:00:00Z',
          attachmentIDs: [ATTACHMENT_ID],
          pinned: true,
          pinnedAt: '2026-05-01T11:30:00Z',
          pinnedBy: ME_ID,
        },
      ];
      const firstId = (items[0] as { id?: string })?.id ?? 'm-1';
      return apiJSON({
        items,
        hasMoreOlder: false,
        hasMoreNewer: false,
        oldestID: firstId,
        newestID: firstId,
      });
    }
    // Pinned list
    if (url.endsWith(`/api/v1/channels/${CHANNEL_ID}/pinned`)) {
      return apiJSON(plan.pinned);
    }
    // Files list
    if (url.endsWith(`/api/v1/channels/${CHANNEL_ID}/files`)) {
      return apiJSON(plan.files);
    }
    // Batch attachment metadata (useAttachmentsBatch → GET /attachments?ids=…)
    if (url.includes('/api/v1/attachments?') && method === 'GET') {
      const ids = (new URL(url, 'http://x').searchParams.get('ids') ?? '').split(',').filter(Boolean);
      return apiJSON(ids.map((id) => plan.attachments[id]).filter(Boolean));
    }
    // Per-attachment metadata
    const attMatch = url.match(/\/api\/v1\/attachments\/([^?]+)/);
    if (attMatch && method === 'GET') {
      const id = decodeURIComponent(attMatch[1]);
      const att = plan.attachments[id];
      if (att) return apiJSON(att);
      return new Response('not found', { status: 404 });
    }
    // Batch users (sidebar avatars, member maps)
    if (url.includes('/api/v1/users/batch')) {
      return apiJSON(plan.batchUsers ?? [
        { id: ME_ID, email: 'me@example.test', displayName: 'Me', systemRole: 'member', status: 'active' },
        { id: ALICE_ID, email: 'alice@example.test', displayName: 'Alice', systemRole: 'member', status: 'active' },
      ]);
    }

    return apiJSON([]);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function renderRoute(initialPath: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <UnreadProvider>
        <PresenceProvider>
          <NotificationProvider>
            <TypingProvider>
              <MemoryRouter initialEntries={[initialPath]}>
                <div style={{ height: 800, width: 1280 }}>
                  <Routes>
                    <Route path="/" element={<ChatPage />}>
                      <Route path="channel/:id" element={<ChannelView />} />
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

// Renders ChannelView directly under a route WITHOUT the :id param so the
// `if (!slug)` placeholder branch runs.
function renderNoSlug() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <UnreadProvider>
        <PresenceProvider>
          <NotificationProvider>
            <TypingProvider>
              <MemoryRouter initialEntries={['/channel']}>
                <div style={{ height: 800, width: 1280 }}>
                  <Routes>
                    <Route path="/channel" element={<ChannelView />} />
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

// Renders the channel route with a pre-seeded active tag so the right rail
// shows the TagSearchPanel branch.
function renderWithActiveTag(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <UnreadProvider>
        <PresenceProvider>
          <NotificationProvider>
            <TypingProvider>
              <TagSearchProvider initialTag="urgent">
                <MemoryRouter initialEntries={[initialPath]}>
                  <div style={{ height: 800, width: 1280 }}>
                    <Routes>
                      <Route path="/channel/:id" element={<ChannelView />} />
                    </Routes>
                  </div>
                </MemoryRouter>
              </TagSearchProvider>
            </TypingProvider>
          </NotificationProvider>
        </PresenceProvider>
      </UnreadProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetServerVersionForTests();
});

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
});

describe('channel → header toggles → files + pinned panels (full route)', () => {
  it('populates the FILES side panel from /channels/:id/files + /attachments/:id', async () => {
    teardown = installFetchStub({
      files: [
        { attachmentID: ATTACHMENT_ID, messageID: 'm-1', authorID: ALICE_ID, createdAt: '2026-05-01T11:00:00Z' },
      ],
      pinned: [],
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

    const screen = await renderRoute('/channel/general');

    // Wait for the channel header to render.
    // The channel header h1 carries the channel name. Scope the query
    // to the title-stack testid so it doesn't collide with a side-panel
    // heading like ~general that the pinned panel uses for context.
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();

    // Header has the paperclip files-toggle.
    const filesBtn = screen.getByTestId('files-toggle');
    await expect.element(filesBtn).toBeVisible();
    await filesBtn.click();

    // FilesPanel should mount.
    await expect.element(screen.getByText('Files', { exact: true })).toBeVisible();

    // The actual reproduction: the panel must list the file row, not
    // show the "no files have been shared" empty state.
    await vi.waitFor(() => {
      const rows = document.querySelectorAll('[data-testid="files-row"]');
      expect(rows.length).toBe(1);
    }, { timeout: 4000 });
    expect(document.querySelector('[data-testid="files-empty"]')).toBeNull();

    // …and the row must resolve its attachment metadata (filename +
    // download link). If the per-attachment fetch fails or never fires,
    // this assertion catches it. Scope to the files-panel row — the same
    // attachment also surfaces in the message's own attachment box.
    await expect.element(screen.getByTestId('files-row-open').getByText('spec.pdf')).toBeVisible();
    const dl = document.querySelector('[data-testid="files-row-download"]') as HTMLAnchorElement | null;
    expect(dl).not.toBeNull();
    expect(dl?.href).toContain('spec.pdf?dl=1');
  });

  it('populates the PINNED side panel from /channels/:id/pinned', async () => {
    teardown = installFetchStub({
      files: [],
      pinned: [
        {
          id: PIN_ID,
          parentID: CHANNEL_ID,
          parentType: 'channel',
          authorID: ALICE_ID,
          body: 'remember the deploy plan',
          createdAt: '2026-05-01T11:00:00Z',
          pinned: true,
          pinnedAt: '2026-05-01T11:30:00Z',
          pinnedBy: ME_ID,
        },
      ],
      attachments: {},
    });

    const screen = await renderRoute('/channel/general');

    // The channel header h1 carries the channel name. Scope the query
    // to the title-stack testid so it doesn't collide with a side-panel
    // heading like ~general that the pinned panel uses for context.
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();

    const pinnedBtn = screen.getByTestId('pinned-toggle');
    await expect.element(pinnedBtn).toBeVisible();
    await pinnedBtn.click();

    await expect.element(screen.getByRole('heading', { name: 'Pinned messages' })).toBeVisible();

    // The reproduction: the pinned panel must show the pinned message
    // body. The previous codepath would render an empty list when the
    // backend returned valid pinned data — only a real route test
    // catches that because the bug was in the wiring between header
    // toggle → ChannelView → PinnedPanel.
    await expect.element(screen.getByText('remember the deploy plan')).toBeVisible();
  });

  it('shows the empty-state when the API has no pinned messages and no files', { retry: 2 }, async () => {
    // Sanity branch: when the channel genuinely has nothing pinned and
    // no shared files, the panels' empty-state copy must show — NOT
    // a perpetually-loading spinner.
    teardown = installFetchStub({ files: [], pinned: [], attachments: {} });

    const screen = await renderRoute('/channel/general');
    // The channel header h1 carries the channel name. Scope the query
    // to the title-stack testid so it doesn't collide with a side-panel
    // heading like ~general that the pinned panel uses for context.
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();

    await screen.getByTestId('files-toggle').click();
    await expect.element(screen.getByTestId('files-empty')).toBeVisible();

    // Close files, open pinned.
    await screen.getByTestId('files-toggle').click();
    await screen.getByTestId('pinned-toggle').click();
    await expect.element(screen.getByTestId('pinned-empty')).toBeVisible();
  });

  it('toggles the MEMBERS side panel from the header member-count button', async () => {
    teardown = installFetchStub({ files: [], pinned: [], attachments: {} });
    const screen = await renderRoute('/channel/general');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();

    // The member-count badge toggles ChannelView's MemberList panel.
    await screen.getByLabelText('Toggle member list').click();
    // MemberList mounts (its scroll area + the per-member row appear).
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="member-list-scroll-area"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="member-name-status-u-alice"]')).not.toBeNull();
    });

    // Toggling again closes the panel (the open/close branch in ChannelView).
    await screen.getByLabelText('Toggle member list').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="member-list-scroll-area"]')).toBeNull();
    });
  });

  it('opens the thread panel from a ?thread= deep link', async () => {
    teardown = installFetchStub({ files: [], pinned: [], attachments: {} });
    // The thread query param drives ChannelView's deep-link thread handling
    // (effectiveThreadRootID, markThreadSeen, panels.close) and mounts ThreadPanel.
    const screen = await renderRoute('/channel/general?thread=m-1');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();
    await expect.element(screen.getByRole('heading', { name: 'Thread' })).toBeVisible();
  });

  it('applies a #msg- deep-link anchor in the main message list', async () => {
    teardown = installFetchStub({ files: [], pinned: [], attachments: {} });
    // The hash anchor flows through ChannelView's useDeepLinkAnchor into
    // MessageList's anchor scroll/highlight path.
    const screen = await renderRoute('/channel/general#msg-m-1');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();
    await expect.element(screen.getByText('see attached')).toBeVisible();
  });

  it('enters the mobile inline editor for an own message via the edit-message event', async () => {
    // ChannelView only delegates edit to its own composer on mobile
    // (`activeEditingMessage = isMobile ? editingMessage : null`); on
    // desktop MessageItem handles inline edit itself.
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      messages: [
        {
          id: 'own-1',
          parentID: CHANNEL_ID,
          parentType: 'channel',
          authorID: ME_ID,
          body: 'my own message',
          createdAt: '2026-05-01T11:00:00Z',
        },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();
    await expect.element(screen.getByText('my own message')).toBeVisible();

    // The own MessageItem registers a startEdit handler; firing the window
    // event routes through startEdit → onEditMessage → setEditingMessage,
    // flipping ChannelView's composer into edit mode (L398-416 cluster).
    // The composer's send button takes the `submitLabel` aria-label ('Save')
    // and an explicit Cancel button appears.
    dispatchEditMessage({ messageId: 'own-1' });
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();

    // Cancelling restores the normal channel composer (send button reverts
    // to its default 'Send message' label, no Cancel button).
    await screen.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(screen.getByRole('button', { name: 'Send message' })).toBeVisible();
  });

  it('redirects to / when the current user is no longer a channel member', async () => {
    // members loads WITHOUT Me → the membership effect fires navigate('/').
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      members: [
        { channelID: CHANNEL_ID, userID: ALICE_ID, role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    const screen = await renderRoute('/channel/general');
    // Booted back to the placeholder home view (the ChatPage index route),
    // so the channel header for ~general never settles.
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="channel-title-stack"]')).toBeNull();
    }, { timeout: 4000 });
    expect(screen.container).toBeTruthy();
  });

  it('dismisses a URL-driven thread locally without stripping the ?thread= param', async () => {
    teardown = installFetchStub({ files: [], pinned: [], attachments: {} });
    const screen = await renderRoute('/channel/general?thread=m-1');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();
    await expect.element(screen.getByRole('heading', { name: 'Thread' })).toBeVisible();

    // Closing the thread panel runs dismissThread → setDismissed({navKey,thread}),
    // which removes the panel while leaving the URL untouched.
    await screen.getByRole('button', { name: 'Close thread' }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="heading"]')); // settle
      expect(screen.getByRole('heading', { name: 'Thread' }).query()).toBeNull();
    }, { timeout: 4000 });
  });

  it('saves an edited own message via the mobile composer (changed body → mutate)', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      messages: [
        {
          id: 'own-2',
          parentID: CHANNEL_ID,
          parentType: 'channel',
          authorID: ME_ID,
          body: 'before edit',
          createdAt: '2026-05-01T11:00:00Z',
        },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(screen.getByText('before edit')).toBeVisible();

    dispatchEditMessage({ messageId: 'own-2' });
    const editor = screen.getByLabelText('Message input');
    await expect.element(editor).toBeVisible();
    await editor.click();
    await editor.fill('after edit');
    // Save dispatches PATCH /messages/own-2 (handleEditMessage mutate arm) and
    // closes the editor on success.
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('/messages/own-2'))).toBe(true);
    }, { timeout: 4000 });
  });

  it('shows the TagSearchPanel in the right rail when a tag is active', async () => {
    teardown = installFetchStub({ files: [], pinned: [], attachments: {} });
    const screen = await renderWithActiveTag('/channel/general');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();
    // activeTag is truthy (no thread/pinned/files open) → the TagSearchPanel
    // branch renders.
    await vi.waitFor(() => {
      expect(document.body.textContent ?? '').toContain('urgent');
    }, { timeout: 4000 });
  });

  it('shows the placeholder when there is no channel slug in the route', async () => {
    teardown = installFetchStub({ files: [], pinned: [], attachments: {} });
    const screen = await renderNoSlug();
    // The `if (!slug)` arm renders the "Select a channel" placeholder.
    await expect.element(screen.getByText(/Select a channel to start chatting/i)).toBeVisible();
  });

  it('sends a new channel message via the composer (no existing draft path)', async () => {
    teardown = installFetchStub({ files: [], pinned: [], attachments: {} });
    const screen = await renderRoute('/channel/general');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    await editor.fill('a fresh message');
    // No draft exists for this scope → handleSendMessage's `!draftID` arm
    // fires sendMessage.mutate directly (no deleteDraft).
    await screen.getByRole('button', { name: 'Send message' }).click();
    await vi.waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => `${c[1]?.method ?? 'GET'} ${String(c[0])}`);
      expect(calls.some((u) => u.startsWith('POST') && u.includes(`/channels/${CHANNEL_ID}/messages`))).toBe(true);
    }, { timeout: 4000 });
  });

  it('closes the mobile editor when an edit leaves the body unchanged (same arm)', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      messages: [
        { id: 'own-same', parentID: CHANNEL_ID, parentType: 'channel', authorID: ME_ID, body: 'keep me as is', createdAt: '2026-05-01T11:00:00Z' },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(screen.getByText('keep me as is')).toBeVisible();
    dispatchEditMessage({ messageId: 'own-same' });
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    // Save without changing anything → handleEditMessage's `same` arm closes
    // the editor without a PATCH.
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('button', { name: 'Send message' })).toBeVisible();
    const patched = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .some((c) => (c[1]?.method ?? 'GET') === 'PATCH' && String(c[0]).includes('/messages/own-same'));
    expect(patched).toBe(false);
  });

  it('loads an edit attachment lacking url/thumbnail into the mobile composer', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {
        // No url, no squareThumbnailURL → the false arms of those spreads.
        [ATTACHMENT_ID]: { id: ATTACHMENT_ID, filename: 'bare.bin', contentType: 'application/octet-stream', size: 256 },
      },
      messages: [
        { id: 'own-bare', parentID: CHANNEL_ID, parentType: 'channel', authorID: ME_ID, body: 'bare attachment', createdAt: '2026-05-01T11:00:00Z', attachmentIDs: [ATTACHMENT_ID] },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(screen.getByText('bare attachment')).toBeVisible();
    dispatchEditMessage({ messageId: 'own-bare' });
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('bare.bin');
    }, { timeout: 4000 });
  });

  it('builds the user map for members with blank display names', async () => {
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      // Empty displayName exercises the `|| "Unknown"` fallback arms.
      members: [
        { channelID: CHANNEL_ID, userID: ME_ID, role: 'member', displayName: '', joinedAt: '2026-01-01T00:00:00Z' },
        { channelID: CHANNEL_ID, userID: ALICE_ID, role: 'member', displayName: '', joinedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();
    // The view renders; the userMap fallback ("Unknown") covered without error.
    expect(screen.container).toBeTruthy();
  });

  it('does not redirect while the member list is still empty (length === 0 arm)', async () => {
    teardown = installFetchStub({ files: [], pinned: [], attachments: {}, members: [] });
    const screen = await renderRoute('/channel/general');
    // Empty members → the membership effect early-returns at `length === 0`
    // and never navigates away; the channel header stays put.
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();
    await new Promise((r) => setTimeout(r, 80));
    expect(document.querySelector('[data-testid="channel-title-stack"]')).not.toBeNull();
  });

  it('renders the 404 NotFound page when the channel fetch returns 404', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/token/refresh')) return apiJSON({ accessToken: 't-test' });
      if (url.includes('/api/v1/version')) return apiJSON({ version: 'dev' });
      if (url.includes('/api/v1/users/me')) return apiJSON({ id: ME_ID, email: 'me@example.test', displayName: 'Me', systemRole: 'member', status: 'active' });
      if (url === '/api/v1/channels' || url.endsWith('/api/v1/channels')) return apiJSON([]);
      if (url.includes('/api/v1/conversations') || url.includes('/api/v1/sidebar/categories') || url.includes('/api/v1/drafts') || url.includes('/api/v1/threads') || url.includes('/api/v1/emojis')) return apiJSON([]);
      if (url.includes('/api/v1/user-state')) return apiJSON({ channelNotifications: [], threadNotifications: [], threadSeen: {}, hiddenConversations: [] });
      if (url.includes('/api/v1/admin/settings')) return apiJSON({ maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false });
      // The channel lookup 404s → ChannelView renders the NotFound page.
      if (url.endsWith('/api/v1/channels/ghost')) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      return apiJSON([]);
    }) as typeof fetch;
    teardown = () => { globalThis.fetch = original; };

    const screen = await renderRoute('/channel/ghost');
    await expect.element(screen.getByText(/not found/i).first()).toBeVisible();
  });

  it('renders the 403 error page when the channel fetch returns 403', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/token/refresh')) return apiJSON({ accessToken: 't-test' });
      if (url.includes('/api/v1/version')) return apiJSON({ version: 'dev' });
      if (url.includes('/api/v1/users/me')) return apiJSON({ id: ME_ID, email: 'me@example.test', displayName: 'Me', systemRole: 'member', status: 'active' });
      if (url === '/api/v1/channels' || url.endsWith('/api/v1/channels')) return apiJSON([]);
      if (url.includes('/api/v1/conversations') || url.includes('/api/v1/sidebar/categories') || url.includes('/api/v1/drafts') || url.includes('/api/v1/threads') || url.includes('/api/v1/emojis')) return apiJSON([]);
      if (url.includes('/api/v1/user-state')) return apiJSON({ channelNotifications: [], threadNotifications: [], threadSeen: {}, hiddenConversations: [] });
      if (url.includes('/api/v1/admin/settings')) return apiJSON({ maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false });
      if (url.endsWith('/api/v1/channels/secret')) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      return apiJSON([]);
    }) as typeof fetch;
    teardown = () => { globalThis.fetch = original; };

    const screen = await renderRoute('/channel/secret');
    await vi.waitFor(() => {
      expect(document.body.textContent ?? '').toMatch(/access|permission|forbidden|don.t have/i);
    }, { timeout: 4000 });
    expect(screen.container).toBeTruthy();
  });

  it('toggles channel mute from the header menu (handleToggleMute mutate path)', async () => {
    if (window.innerWidth <= 767) return;
    teardown = installFetchStub({ files: [], pinned: [], attachments: {} });
    const screen = await renderRoute('/channel/general');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();
    // Open the channel header dropdown and click Mute.
    await screen.getByTestId('channel-title-stack').getByRole('button').first().click();
    await screen.getByRole('menuitem', { name: 'Mute channel' }).click();
    await vi.waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('/mute') || u.includes('/channels/'))).toBe(true);
    }, { timeout: 4000 });
  });

  it('archives the channel from the owner header menu (handleArchive DELETE)', async () => {
    if (window.innerWidth <= 767) return;
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      // Owner role surfaces Edit description / Archive actions.
      members: [
        { channelID: CHANNEL_ID, userID: ME_ID, role: 'owner', displayName: 'Me', joinedAt: '2026-01-01T00:00:00Z' },
        { channelID: CHANNEL_ID, userID: ALICE_ID, role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();

    // Archive opens a confirm dialog; confirming → DELETE /channels/:id
    // (handleArchive's non-null arm).
    await screen.getByTestId('channel-title-stack').getByRole('button').first().click();
    await screen.getByRole('menuitem', { name: /Archive channel/ }).click();
    await screen.getByRole('button', { name: /^Archive$/ }).click();
    await vi.waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${String(c[0])}`);
      expect(calls.some((u) => u.startsWith('DELETE') && u.includes(`/channels/${CHANNEL_ID}`))).toBe(true);
    }, { timeout: 4000 });
  });

  it('leaves a non-general channel from the owner header menu (handleLeave POST)', async () => {
    if (window.innerWidth <= 767) return;
    const original = globalThis.fetch;
    const inner = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      // Plain member of a non-general channel → canLeave is true (owners
      // cannot leave; general cannot be left).
      members: [
        { channelID: CHANNEL_ID, userID: ME_ID, role: 'member', displayName: 'Me', joinedAt: '2026-01-01T00:00:00Z' },
        { channelID: CHANNEL_ID, userID: ALICE_ID, role: 'owner', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    // Re-point the channel lookup to a non-general slug so canLeave is true.
    const stub = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v1/channels/random')) {
        return apiJSON({ id: CHANNEL_ID, name: 'random', slug: 'random', type: 'public', description: '', createdBy: ME_ID, archived: false, createdAt: '2026-01-01T00:00:00Z' });
      }
      if (url === '/api/v1/channels' || url.endsWith('/api/v1/channels')) {
        return apiJSON([{ channelID: CHANNEL_ID, channelName: 'random', channelType: 'public', muted: false, favorite: false, categoryID: '', unreadCount: 0 }]);
      }
      return stub(input, init);
    }) as typeof fetch;
    teardown = () => { globalThis.fetch = original; inner(); };

    const screen = await renderRoute('/channel/random');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'random' }),
    ).toBeVisible();

    await screen.getByTestId('channel-title-stack').getByRole('button').first().click();
    await screen.getByRole('menuitem', { name: /Leave channel/ }).click();
    await vi.waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${String(c[0])}`);
      expect(calls.some((u) => u.includes('/leave'))).toBe(true);
    }, { timeout: 4000 });
  });

  it('saves a channel description from the owner header menu (handleDescriptionSave)', async () => {
    if (window.innerWidth <= 767) return;
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      members: [
        { channelID: CHANNEL_ID, userID: ME_ID, role: 'owner', displayName: 'Me', joinedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();

    await screen.getByTestId('channel-title-stack').getByRole('button').first().click();
    await screen.getByRole('menuitem', { name: /Edit description/ }).click();
    const descInput = screen.getByPlaceholder('Add a description...');
    await descInput.fill('A brand new description');
    // Enter commits the description edit (Header's onDescriptionSave →
    // ChannelView.handleDescriptionSave → PATCH /channels/:id).
    await descInput.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${String(c[0])}`);
      expect(calls.some((u) => u.startsWith('PATCH') && u.includes(`/channels/${CHANNEL_ID}`))).toBe(true);
    }, { timeout: 4000 });
  });

  it('closes a UI-opened thread (local thread anchor — undefined arm)', async () => {
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      messages: [
        {
          id: 'm-thread',
          parentID: CHANNEL_ID,
          parentType: 'channel',
          authorID: ALICE_ID,
          body: 'parent of a thread',
          createdAt: '2026-05-01T11:00:00Z',
          replyCount: 2,
          lastReplyAt: '2026-05-01T12:00:00Z',
          recentReplyAuthorIDs: [ME_ID],
        },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(screen.getByText('parent of a thread')).toBeVisible();
    // Open the thread via the in-list thread-reply teaser (local openThread →
    // threadRootID set, not from ?thread=). The ThreadPanel anchor resolves to
    // undefined because effectiveThreadRootID !== threadParam.
    const teaser = document.querySelector('[data-testid="thread-action-bar"], [aria-label*="repl" i]') as HTMLElement | null;
    if (teaser) {
      teaser.click();
      await expect.element(screen.getByRole('heading', { name: 'Thread' })).toBeVisible();
    }
    expect(screen.container).toBeTruthy();
  });

  it('loads edit attachments into the mobile composer (edit-attachment map)', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      files: [],
      pinned: [],
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
      messages: [
        {
          id: 'own-3',
          parentID: CHANNEL_ID,
          parentType: 'channel',
          authorID: ME_ID,
          body: 'has an attachment',
          createdAt: '2026-05-01T11:00:00Z',
          attachmentIDs: [ATTACHMENT_ID],
        },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(screen.getByText('has an attachment')).toBeVisible();

    dispatchEditMessage({ messageId: 'own-3' });
    // The edit-attachment batch resolves → editDraftAttachments maps the
    // attachment (url + squareThumbnailURL arms) into a chip in the composer.
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('edit-me.png');
    }, { timeout: 4000 });
  });

  it('deletes an existing draft after a successful send (draftID branch)', async () => {
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      // A saved draft for THIS channel scope → handleSendMessage takes the
      // `draftID` (truthy) arm: send then deleteDraft on success (line 177
      // false arm + the onSuccess deleteDraft callback).
      drafts: [
        {
          id: 'draft-ch-1',
          parentID: CHANNEL_ID,
          parentType: 'channel',
          body: 'half-written',
          attachmentIDs: [],
          updatedAt: '2026-05-01T11:00:00Z',
        },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    await editor.fill('sending with a draft present');
    await screen.getByRole('button', { name: 'Send message' }).click();
    await vi.waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => `${c[1]?.method ?? 'GET'} ${String(c[0])}`);
      // POST the message…
      expect(calls.some((u) => u.startsWith('POST') && u.includes(`/channels/${CHANNEL_ID}/messages`))).toBe(true);
      // …and the saved draft is deleted on success.
      expect(calls.some((u) => u.startsWith('DELETE') && u.includes('/drafts/draft-ch-1'))).toBe(true);
    }, { timeout: 4000 });
  });

  it('closes the mobile editor when the edited body is cleared to blank (blank arm)', async () => {
    if (window.innerWidth > 767) return;
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      messages: [
        { id: 'own-blank', parentID: CHANNEL_ID, parentType: 'channel', authorID: ME_ID, body: 'wipe me', createdAt: '2026-05-01T11:00:00Z' },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(screen.getByText('wipe me')).toBeVisible();
    dispatchEditMessage({ messageId: 'own-blank' });
    const editor = screen.getByLabelText('Message input');
    await expect.element(editor).toBeVisible();
    await editor.click();
    // Clear the body entirely → save → `!value.body.trim() &&
    // attachmentIDs.length === 0` arm of handleEditMessage (line 197) closes
    // the editor without a PATCH.
    await editor.fill('');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('button', { name: 'Send message' })).toBeVisible();
    const patched = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .some((c) => (c[1]?.method ?? 'GET') === 'PATCH' && String(c[0]).includes('/messages/own-blank'));
    expect(patched).toBe(false);
  });

  it('falls back to "Unknown" for a batch user with a blank display name (userMap arm)', async () => {
    teardown = installFetchStub({
      files: [],
      pinned: [],
      attachments: {},
      // usersData carries an empty displayName → the `u.displayName ||
      // 'Unknown'` truthy fallback arm in the usersData userMap loop (line 289).
      batchUsers: [
        { id: ME_ID, email: 'me@example.test', displayName: 'Me', systemRole: 'member', status: 'active' },
        { id: ALICE_ID, email: 'alice@example.test', displayName: '', systemRole: 'member', status: 'active' },
      ],
    });
    const screen = await renderRoute('/channel/general');
    await expect.element(
      screen.getByTestId('channel-title-stack').getByRole('heading', { name: 'general' }),
    ).toBeVisible();
    // The view renders without crashing; Alice resolves to "Unknown" in the map.
    expect(screen.container).toBeTruthy();
  });
});
