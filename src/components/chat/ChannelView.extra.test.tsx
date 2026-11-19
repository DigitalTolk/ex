import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// MarkdownComposer pulls in roster/channel/emoji/auth/presence data hooks these
// view-level tests don't stub; they don't exercise the composer, so stub it with
// a plain textarea (matches the message-input-validation stub).
vi.mock('@/components/chat/markdown/MarkdownComposer', () => ({
  MarkdownComposer: (props: {
    ariaLabel?: string;
    placeholder?: string;
    onChange?: (md: string) => void;
    onSubmit?: (md: string) => void;
  }) => (
    <div>
      <textarea
        aria-label={props.ariaLabel ?? 'Message input'}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            props.onSubmit?.((e.target as HTMLTextAreaElement).value);
          }
        }}
        data-testid="composer-stub"
      />
      {props.placeholder ? <span>{props.placeholder}</span> : null}
    </div>
  ),
}));
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Channel, ChannelMembership } from '@/types';

// Mock dropdown to a simple structure so we can click items in jsdom
vi.mock('@/components/ui/dropdown-menu');

// The picker has its own tests; here it is its trigger and the kinds of pick
// it can hand back: a standard emoji, one with a skin tone after it, and a
// workspace's own.
vi.mock('@/components/EmojiPicker', () => ({
  EmojiPicker: ({ onSelect, trigger }: { onSelect: (emoji: string) => void; trigger: React.ReactNode }) => (
    <span data-testid="emoji-picker">
      {trigger}
      <button type="button" onClick={() => onSelect(':rocket:')}>
        Pick rocket
      </button>
      <button type="button" onClick={() => onSelect(':wave::skin-tone-3:')}>
        Pick toned wave
      </button>
      <button type="button" onClick={() => onSelect(':partyparrot:')}>
        Pick custom parrot
      </button>
    </span>
  ),
}));

// Mock dialog so the archive confirm always shows
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  // Header's archive confirm goes through the shared ConfirmDialog, which
  // also pulls this primitive.
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockChannel: Channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  description: 'Old description',
};

let mockMembers: ChannelMembership[] = [
  { channelID: 'ch-1', userID: 'u-1', role: 'owner', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
];

vi.mock('@/context/AuthContext', () => {
  const auth = {
  useAuth: () => ({
    user: { id: 'u-1', displayName: 'Alice', email: 'a@a.com', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    setAuth: vi.fn(),
  }),
};
  return { ...auth, useOptionalAuth: auth.useAuth };
});

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set(),
    unreadChannelNotifications: new Set(),
    unreadConversations: new Set(),
    markChannelUnread: vi.fn(),
    markChannelNotificationUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
    setActiveChannel: vi.fn(),
    setActiveConversation: vi.fn(),
    isActiveChannel: vi.fn(() => false),
    isActiveConversation: vi.fn(() => false),
    setActiveThread: vi.fn(),
    isActiveThread: vi.fn(() => false),
  }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set<string>(),
    isOnline: () => false,
    setUserOnline: vi.fn(),
  }),
  PresenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The archive/leave/description mutations stay real (they call the mocked
// apiFetch below); only the queries are stubbed.
vi.mock('@/hooks/useChannels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useChannels')>()),
  useChannelBySlug: () => ({ data: mockChannel }),
  useChannelMembers: () => ({ data: mockMembers }),
  // Applies `select` like the real hook (ChannelView selects its own row).
  useUserChannels: (opts?: { select?: (rows: never[]) => unknown }) => {
    const rows = [] as never[];
    return { data: opts?.select && rows ? opts.select(rows) : rows };
  },
  useBrowseChannels: () => ({ data: [] }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useMuteChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

const mockSendMutate = vi.fn();
vi.mock('@/hooks/useMessages', () => ({
  useChannelMessages: () => ({
    data: { pages: [{ items: [] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    fetchNextPage: vi.fn(),
  }),
  useSendMessage: () => ({ mutate: mockSendMutate, isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/lib/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/toast')>()),
  showToast: vi.fn(),
}));
import { showToast } from '@/lib/toast';

// Import after mocks
import { ChannelView } from './ChannelView';

function renderChannelView(slug = 'general') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/channel/${slug}`]}>
        <Routes>
          <Route path="/channel/:id" element={<ChannelView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Default mock implementation: return populated users for batch, {} for everything else
function setDefaultApi() {
  mockApiFetch.mockImplementation((url: string) => {
    if (url === '/api/v1/users/batch') {
      return Promise.resolve([
        { id: 'u-1', displayName: 'Alice', avatarURL: 'http://x/a.png' },
        { id: 'u-2', displayName: '', avatarURL: undefined }, // exercises 'Unknown' fallback (line 76)
      ]);
    }
    return Promise.resolve({});
  });
}

describe('ChannelView - actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembers = [
      { channelID: 'ch-1', userID: 'u-1', role: 'owner', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
    ];
    mockChannel.archived = false;
    mockChannel.description = 'Old description';
    delete mockChannel.icon;
    setDefaultApi();
  });

  it('renders nothing when slug missing', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/channel/']}>
          <Routes>
            <Route path="/channel/" element={<ChannelView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/select a channel to start chatting/i)).toBeInTheDocument();
  });

  it('handleSend forwards body to send mutation', async () => {
    const user = userEvent.setup();
    renderChannelView();

    const input = screen.getByLabelText('Message input');
    await user.type(input, 'hello world{enter}');

    expect(mockSendMutate).toHaveBeenCalledWith(
      { body: 'hello world', attachmentIDs: [] },
    );
  });

  it('owner can archive channel — archives via apiFetch DELETE and stays on the channel', async () => {
    renderChannelView();

    // Click "Archive channel" item directly
    const items = await screen.findAllByTestId('dropdown-item');
    const archiveItem = items.find((b) => b.textContent?.includes('Archive channel'));
    expect(archiveItem).toBeDefined();
    fireEvent.click(archiveItem!);

    // Confirm in dialog
    fireEvent.click(screen.getByText('Archive'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    // Archiving keeps the channel readable: no navigation away.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('archived channel: read-only notice replaces the composer; the owner unarchives from it', async () => {
    mockChannel.archived = true;
    renderChannelView();

    expect(screen.getByTestId('channel-archived-notice')).toHaveTextContent('This channel is archived. Its history is read-only.');
    expect(screen.queryByLabelText('Message input')).not.toBeInTheDocument();
    // The header offers Unarchive instead of Archive, and no description edit.
    const items = await screen.findAllByTestId('dropdown-item');
    expect(items.some((b) => b.textContent?.includes('Archive channel'))).toBe(false);
    expect(items.some((b) => b.textContent?.includes('Edit description'))).toBe(false);
    expect(items.some((b) => b.textContent?.includes('Unarchive channel'))).toBe(true);

    const unarchive = within(screen.getByTestId('channel-archived-notice')).getByRole('button', { name: /Unarchive/ });
    fireEvent.click(unarchive);
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1/unarchive',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => expect(unarchive).not.toBeDisabled());
  });

  it('archived channel: a plain member sees the notice without an Unarchive button', () => {
    mockChannel.archived = true;
    mockMembers = [
      { channelID: 'ch-1', userID: 'u-1', role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
    ];
    renderChannelView();
    const notice = screen.getByTestId('channel-archived-notice');
    expect(notice).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Unarchive/ })).not.toBeInTheDocument();
  });

  it('member can leave non-general channel — POSTs to /leave and navigates', async () => {
    // Use a non-general slug so the #general lockdown doesn't apply.
    mockChannel.slug = 'random';
    mockChannel.name = 'random';
    mockMembers = [
      { channelID: 'ch-1', userID: 'u-1', role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
    ];
    renderChannelView('random');

    const items = await screen.findAllByTestId('dropdown-item');
    const leaveItem = items.find((b) => b.textContent?.includes('Leave channel'));
    expect(leaveItem).toBeDefined();
    fireEvent.click(leaveItem!);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1/leave',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
    // Restore for subsequent tests in this file.
    mockChannel.slug = 'general';
    mockChannel.name = 'general';
  });

  it('member cannot leave the #general channel', async () => {
    mockChannel.slug = 'general';
    mockChannel.name = 'general';
    mockMembers = [
      { channelID: 'ch-1', userID: 'u-1', role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
    ];
    renderChannelView();

    // Either the actions dropdown is empty (no leave to show) and not
    // rendered, or it exists with no Leave channel item — both are valid.
    const items = screen.queryAllByTestId('dropdown-item');
    const leaveItem = items.find((b) => b.textContent?.includes('Leave channel'));
    expect(leaveItem).toBeUndefined();
  });

  // The description's first line sits beside the channel name; the whole of
  // it opens from there, and whoever may edit the channel edits it from that
  // dialog (canEdit here because role=owner).
  it('handleDescriptionSave PATCHes the channel', async () => {
    renderChannelView();

    fireEvent.click(screen.getByTestId('channel-description-teaser'));
    fireEvent.click(screen.getByTestId('channel-description-edit'));
    const input = screen.getByPlaceholderText('What is this channel for?');
    expect(input).toHaveValue('Old description');
    // Several lines are kept as written; only the ends are trimmed.
    fireEvent.change(input, { target: { value: '  New desc\nRunbook: https://example.com/runbook \n' } });
    fireEvent.click(screen.getByTestId('channel-description-save'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ description: 'New desc\nRunbook: https://example.com/runbook' }),
        }),
      );
    });
    // The editor closes on save.
    expect(screen.queryByPlaceholderText('What is this channel for?')).not.toBeInTheDocument();
  });

  // The channel menu's "Edit description" opens the same editor.
  function editDescriptionFromMenu(text: string) {
    const items = screen.getAllByTestId('dropdown-item');
    fireEvent.click(items.find((b) => b.textContent?.includes('Edit description'))!);
    fireEvent.change(screen.getByPlaceholderText('What is this channel for?'), { target: { value: text } });
    fireEvent.click(screen.getByTestId('channel-description-save'));
  }

  // The channel's icon: whoever may edit the channel picks an emoji from the
  // icon in the header; the channel keeps the emoji's name.
  describe('channel icon', () => {
    const iconPuts = () => mockApiFetch.mock.calls.filter(([url]) => url === '/api/v1/channels/ch-1/icon');
    // The header's picker (the composer has one of its own).
    const pick = (name: string) => fireEvent.click(within(screen.getByTestId('channel-title-stack')).getByRole('button', { name }));

    it('picking an emoji PUTs its name as the channel icon', async () => {
      renderChannelView();
      expect(screen.getByRole('button', { name: 'Change channel icon' })).toBeInTheDocument();
      pick('Pick rocket');
      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/icon', {
          method: 'PUT',
          body: JSON.stringify({ icon: 'rocket' }),
        });
      });
      expect(showToast).not.toHaveBeenCalled();
    });

    it('keeps the name alone of an emoji picked with a skin tone', async () => {
      renderChannelView();
      pick('Pick toned wave');
      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/icon', {
          method: 'PUT',
          body: JSON.stringify({ icon: 'wave' }),
        });
      });
    });

    it("refuses a workspace's own emoji with a message, and sends nothing", () => {
      renderChannelView();
      pick('Pick custom parrot');
      expect(showToast).toHaveBeenCalledWith("A custom emoji can't be a channel icon yet. Pick a standard one.");
      expect(iconPuts()).toHaveLength(0);
    });

    it('"Remove icon" in the channel menu clears it', async () => {
      mockChannel.icon = 'rocket';
      renderChannelView();
      // The emoji is the face of the button that changes it.
      expect(within(screen.getByRole('button', { name: 'Change channel icon' })).getByTestId('channel-emoji')).toHaveTextContent(
        '\u{1F680}',
      );
      const items = screen.getAllByTestId('dropdown-item');
      fireEvent.click(items.find((b) => b.textContent?.includes('Remove icon'))!);
      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/icon', {
          method: 'PUT',
          body: JSON.stringify({ icon: '' }),
        });
      });
      expect(showToast).not.toHaveBeenCalled();
    });

    it('a failed icon change shows an error toast', async () => {
      rejectFor('PUT', '/api/v1/channels/ch-1/icon');
      renderChannelView();
      pick('Pick rocket');
      await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't change the icon. Try again."));
    });

    it('a plain member sees the icon as a mark, with no way to change or remove it', () => {
      mockChannel.icon = 'rocket';
      mockMembers = [
        { channelID: 'ch-1', userID: 'u-1', role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
      ];
      renderChannelView();
      expect(screen.queryByRole('button', { name: 'Change channel icon' })).not.toBeInTheDocument();
      expect(within(screen.getByTestId('channel-title-stack')).queryByTestId('emoji-picker')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('channel-title-stack')).getByRole('img', { name: 'Public channel' })).toHaveTextContent(
        '\u{1F680}',
      );
      expect(screen.queryAllByTestId('dropdown-item').some((b) => b.textContent?.includes('Remove icon'))).toBe(false);
    });

    it('an archived channel keeps its icon as it is, even for its owner', () => {
      mockChannel.icon = 'rocket';
      mockChannel.archived = true;
      renderChannelView();
      expect(screen.queryByRole('button', { name: 'Change channel icon' })).not.toBeInTheDocument();
      expect(within(screen.getByTestId('channel-title-stack')).queryByTestId('emoji-picker')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('channel-title-stack')).getByTestId('channel-emoji')).toHaveTextContent('\u{1F680}');
      expect(screen.queryAllByTestId('dropdown-item').some((b) => b.textContent?.includes('Remove icon'))).toBe(false);
    });
  });

  // A request the server refuses (or that never reaches it) must say so
  // instead of failing silently into an unhandled rejection.
  function rejectFor(method: string, url: string) {
    mockApiFetch.mockImplementation((u: string, init?: { method?: string }) =>
      u === url && init?.method === method ? Promise.reject(new Error('boom')) : Promise.resolve({}),
    );
  }

  // Leaves the matching request pending until release() is called.
  function holdFor(method: string, url: string) {
    let release: () => void = () => {};
    mockApiFetch.mockImplementation((u: string, init?: { method?: string }) => {
      if (u === url && init?.method === method) {
        return new Promise<void>((resolve) => {
          release = () => resolve();
        });
      }
      return Promise.resolve({});
    });
    return () => release();
  }

  async function confirmArchive() {
    const items = await screen.findAllByTestId('dropdown-item');
    fireEvent.click(items.find((b) => b.textContent?.includes('Archive channel'))!);
    fireEvent.click(screen.getByTestId('archive-channel-confirm'));
  }

  it('a failed archive shows an error toast', async () => {
    rejectFor('DELETE', '/api/v1/channels/ch-1');
    renderChannelView();
    await confirmArchive();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't archive the channel. Try again."));
  });

  it('confirming archive again while the first request is in flight sends it once', async () => {
    const release = holdFor('DELETE', '/api/v1/channels/ch-1');
    renderChannelView();
    await confirmArchive();
    await confirmArchive();
    release();
    await waitFor(() =>
      expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1),
    );
  });

  it('a failed unarchive shows an error toast and re-enables the button', async () => {
    mockChannel.archived = true;
    rejectFor('POST', '/api/v1/channels/ch-1/unarchive');
    renderChannelView();
    const unarchive = within(screen.getByTestId('channel-archived-notice')).getByRole('button', { name: /Unarchive/ });
    fireEvent.click(unarchive);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't unarchive the channel. Try again."));
    expect(unarchive).not.toBeDisabled();
  });

  it('a second unarchive click while the first is in flight sends it once', async () => {
    mockChannel.archived = true;
    const release = holdFor('POST', '/api/v1/channels/ch-1/unarchive');
    renderChannelView();
    const unarchive = within(screen.getByTestId('channel-archived-notice')).getByRole('button', { name: /Unarchive/ });
    fireEvent.click(unarchive);
    fireEvent.click(unarchive);
    release();
    await waitFor(() => expect(unarchive).not.toBeDisabled());
    expect(mockApiFetch.mock.calls.filter(([url]) => url === '/api/v1/channels/ch-1/unarchive')).toHaveLength(1);
  });

  describe('leave', () => {
    beforeEach(() => {
      mockChannel.slug = 'random';
      mockChannel.name = 'random';
      mockMembers = [
        { channelID: 'ch-1', userID: 'u-1', role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
      ];
    });
    afterEach(() => {
      mockChannel.slug = 'general';
      mockChannel.name = 'general';
    });

    async function clickLeave() {
      const items = await screen.findAllByTestId('dropdown-item');
      fireEvent.click(items.find((b) => b.textContent?.includes('Leave channel'))!);
    }

    it('a failed leave shows an error toast and stays on the channel', async () => {
      rejectFor('POST', '/api/v1/channels/ch-1/leave');
      renderChannelView('random');
      await clickLeave();
      await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't leave the channel. Try again."));
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('a second leave while the first is in flight sends it once', async () => {
      const release = holdFor('POST', '/api/v1/channels/ch-1/leave');
      renderChannelView('random');
      await clickLeave();
      await clickLeave();
      release();
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
      expect(mockApiFetch.mock.calls.filter(([url]) => url === '/api/v1/channels/ch-1/leave')).toHaveLength(1);
    });
  });

  it('a failed description save shows an error toast', async () => {
    rejectFor('PATCH', '/api/v1/channels/ch-1');
    renderChannelView();
    editDescriptionFromMenu('New desc');
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't save the description. Try again."));
  });
});
