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
}

function installFetchStub(plan: FetchPlan): () => void {
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
        { channelID: CHANNEL_ID, channelName: 'general', channelType: 'public', muted: false, favorite: false, categoryID: '', unreadCount: 0 },
      ]);
    }
    if (url.includes('/api/v1/conversations')) return apiJSON([]);
    if (url.includes('/api/v1/sidebar/categories')) return apiJSON([]);
    if (url.includes('/api/v1/drafts')) return apiJSON([]);
    if (url.includes('/api/v1/user-state')) {
      return apiJSON({ channelNotifications: [], threadNotifications: [], threadSeen: {}, hiddenConversations: [] });
    }
    if (url.includes('/api/v1/threads')) return apiJSON([]);
    if (url.includes('/api/v1/emojis')) return apiJSON([]);
    if (url.includes('/api/v1/admin/settings')) return apiJSON({ maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false });

    // Channel page bootstrap
    if (url.endsWith(`/api/v1/channels/general`)) {
      return apiJSON({
        id: CHANNEL_ID,
        name: 'general',
        slug: 'general',
        type: 'public',
        description: '',
        createdBy: ME_ID,
        archived: false,
        createdAt: '2026-01-01T00:00:00Z',
      });
    }
    if (url.endsWith(`/api/v1/channels/${CHANNEL_ID}/members`)) {
      return apiJSON([
        { channelID: CHANNEL_ID, userID: ME_ID, role: 'member', displayName: 'Me', joinedAt: '2026-01-01T00:00:00Z' },
        { channelID: CHANNEL_ID, userID: ALICE_ID, role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
      ]);
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
      return apiJSON([
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
    // this assertion catches it.
    await expect.element(screen.getByText('spec.pdf')).toBeVisible();
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
});
