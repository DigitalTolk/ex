import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page, server } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { EmojiPicker } from '@/components/EmojiPicker';
import { GiphyPicker } from '@/components/GiphyPicker';
import { UserHoverCard } from '@/components/UserHoverCard';
import { MessageItem } from '@/components/chat/MessageItem';
import { SearchBar } from '@/components/SearchBar';
import { findTextOverlaps } from '@/test/text-overlap';
import type { Message } from '@/types';

// Geometry sweep of the popover surfaces: no two pieces of text may render
// on top of each other. Class-presence tests cannot catch this — the classes
// are all "correct" while the boxes stack — so this asserts on resolved
// layout, per browser project (the desktop popover and the mobile sheets
// have different geometry).

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({
    data: [
      { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', gettingWorkDone: true, createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
      { name: 'shipit', imageURL: 'https://emoji.test/shipit.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
    ],
  }),
  useEmojiMap: () => ({ data: {} }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiFetch: vi.fn(async (url: string) => {
    if (String(url).includes('/users/batch')) return [];
    return {};
  }),
  getAccessToken: () => null,
}));
vi.mock('@/lib/emoji-frequency', () => ({
  EMOJI_FREQUENCY_CHANGED_EVENT: 'emoji-frequency-changed',
  getFrequentEmojis: vi.fn(async () => [':smile:', ':joy:', ':heart:', ':thumbsup:', ':fire:', ':tada:', ':eyes:', ':rocket:', ':pray:']),
  recordEmojiUse: vi.fn(),
}));
vi.mock('@/context/AuthContext', () => {
  const state = () => ({
    user: { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'member', status: 'active', emojiSkinTone: '' },
    isAuthenticated: true,
    isLoading: false,
    setAuth: vi.fn(),
  });
  return {
    useAuth: state,
    useOptionalAuth: state,
    AuthContext: { Provider: ({ children }: { children: React.ReactNode }) => <>{children}</> },
  };
});

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSetNoUnfurl: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useActivity', () => ({
  useCreateReminder: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));
vi.mock('@/hooks/useUnfurl', () => ({ useUnfurl: () => ({ data: undefined, isLoading: false }) }));
// SearchBar data hooks — enough hits to render both result sections plus the
// message actions, so the dropdown carries realistic text density.
vi.mock('@/hooks/useSearch', () => ({
  useSearchUsers: () => ({
    data: {
      hits: [
        { id: 'u-10', _source: { displayName: 'Charlotte Higginbotham-Weatherby', email: 'charlotte.higginbotham@example.com' } },
        { id: 'u-11', _source: { displayName: 'Bo', email: 'bo@example.com' } },
      ],
    },
    isLoading: false,
  }),
  useSearchChannels: () => ({
    data: {
      hits: [
        { id: 'c-10', _source: { name: 'general-discussions-and-announcements', slug: 'general', type: 'public' } },
        { id: 'c-11', _source: { name: 'ops', slug: 'ops', type: 'private' } },
      ],
    },
    isLoading: false,
  }),
}));
vi.mock('@/hooks/useChannels', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useChannelBySlug: () => ({ data: undefined }),
  useUserChannels: () => ({ data: [] }),
}));
vi.mock('@/hooks/useConversations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useUserConversations: () => ({ data: [] }),
  useOpenDM: () => ({ openDM: vi.fn() }),
}));
vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({ map: new Map(), data: [] }),
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>() }),
}));

function Wrap({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function snap(name: string) {
  await page.screenshot({ path: `__screenshots__/popover-overlap-sweep/${server.browser}-${window.innerWidth}-${name}.png` });
}

describe('popover text-overlap sweep', () => {
  it('emoji picker renders with zero overlapping text', async () => {
    const screen = await render(
      <Wrap>
        <EmojiPicker onSelect={() => {}} />
      </Wrap>,
    );
    await screen.getByLabelText('Open emoji picker').click();
    await settle(700); // sheet enter spring
    const portal = document.querySelector('[data-testid="popover-portal"]') as HTMLElement;
    expect(portal).not.toBeNull();
    await snap('emoji-picker');
    expect(findTextOverlaps(portal)).toEqual([]);
  });

  it('giphy picker renders with zero overlapping text', async () => {
    const screen = await render(
      <Wrap>
        <GiphyPicker apiKey="test-key" onSelect={() => {}} trigger={<button type="button">GIF</button>} />
      </Wrap>,
    );
    await screen.getByText('GIF').click();
    await settle(700);
    const portal = document.querySelector('[data-testid="popover-portal"]') as HTMLElement;
    expect(portal).not.toBeNull();
    await snap('giphy-picker');
    expect(findTextOverlaps(portal)).toEqual([]);
  });

  it('message long-press action sheet renders with zero overlapping text', async () => {
    if (window.innerWidth > 767) return; // mobile-only surface
    const message: Message = {
      id: 'msg-1',
      parentID: 'channel-1',
      parentType: 'channel',
      authorID: 'user-2',
      body: 'A reasonably long message body that wraps across a couple of lines on a phone viewport.',
      createdAt: '2026-04-24T10:30:00Z',
      reactions: { ':+1:': ['user-3', 'user-4'], ':tada:': ['user-3'] },
    } as Message;
    await render(
      <Wrap>
        <MessageItem
          message={message}
          authorName="Alice"
          isOwn={false}
          channelId="channel-1"
          channelSlug="general"
          currentUserId="user-9"
        />
      </Wrap>,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', isPrimary: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="mobile-message-actions"]')).not.toBeNull();
    }, { timeout: 2000 });
    await settle(700); // enter spring
    const sheet = document.querySelector('[data-testid="mobile-message-actions"]') as HTMLElement;
    await snap('message-action-sheet');
    expect(findTextOverlaps(sheet)).toEqual([]);
  });

  it('search bar dropdown renders with zero overlapping text', async () => {
    const screen = await render(
      <Wrap>
        <div style={{ width: Math.min(window.innerWidth - 32, 576) }}>
          <SearchBar />
        </div>
      </Wrap>,
    );
    const input = screen.getByTestId('searchbar-input');
    await input.fill('gen');
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="searchbar-dropdown"]')).not.toBeNull();
    });
    await settle(300);
    const dropdown = document.querySelector('[data-testid="searchbar-dropdown"]') as HTMLElement;
    await snap('searchbar-dropdown');
    expect(findTextOverlaps(dropdown)).toEqual([]);
  });

  it('user hover card / profile sheet renders with zero overlapping text', async () => {
    const screen = await render(
      <Wrap>
        <UserHoverCard
          userId="u-2"
          displayName="Bob Example With A Rather Long Name"
          online
          currentUserId="u-1"
          userStatus={{ emoji: ':palm_tree:', text: 'On vacation until next Tuesday', clearAt: '' }}
        >
          <span>Bob</span>
        </UserHoverCard>
      </Wrap>,
    );
    // The card is click-to-open on every tier.
    await screen.getByText('Bob').click();
    await settle(900); // sheet enter spring / position settle
    const portal = document.querySelector('[data-testid="popover-portal"]') as HTMLElement | null;
    expect(portal).not.toBeNull();
    await snap('user-hover-card');
    expect(findTextOverlaps(portal!)).toEqual([]);
  });
});
