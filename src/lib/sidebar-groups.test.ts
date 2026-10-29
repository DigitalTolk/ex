import { describe, it, expect } from 'vitest';
import type { UserChannel, UserConversation, SidebarCategory } from '@/types';
import { archivedSidebarChannels, groupSidebarItems, isSidebarItemUnread, sidebarItemID, SidebarSectionKeys, type SidebarItem } from './sidebar-groups';

function conv(over: Partial<UserConversation>): UserConversation {
  return {
    conversationID: 'c',
    type: 'dm',
    displayName: 'C',
    favorite: false,
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as UserConversation;
}

function cat(over: Partial<SidebarCategory>): SidebarCategory {
  return { id: 'cat', name: 'Cat', position: 0, ...over } as SidebarCategory;
}

describe('groupSidebarItems', () => {
  it('breaks category position ties by id', () => {
    // Two categories with the SAME position must order deterministically
    // by id (exercises the position-tie branch).
    const sections = groupSidebarItems(
      [],
      [],
      [cat({ id: 'zeta', name: 'Zeta', position: 5 }), cat({ id: 'alpha', name: 'Alpha', position: 5 })],
    );
    const catSections = sections.filter((s) => s.category);
    expect(catSections.map((s) => s.category!.id)).toEqual(['alpha', 'zeta']);
  });

  it('sorts recent DMs with one missing timestamp last (finite/non-finite branch)', () => {
    const sections = groupSidebarItems(
      [],
      [
        conv({ conversationID: 'no-time', displayName: 'NoTime', updatedAt: undefined }),
        conv({ conversationID: 'has-time', displayName: 'HasTime', updatedAt: '2026-05-01T00:00:00Z' }),
      ],
      [],
      { conversationSort: 'recent' },
    );
    const dms = sections.find((s) => s.key === SidebarSectionKeys.DirectMessages)!;
    const ids = dms.items.map((i) => (i.kind === 'conversation' ? i.conversation.conversationID : ''));
    // The conversation with a parseable timestamp sorts ahead of the one without.
    expect(ids).toEqual(['has-time', 'no-time']);
  });

  it('keeps the timestamped DM ahead when the comparator sees the pair reversed', () => {
    // Feeding the pair in the opposite input order makes the sort comparator
    // evaluate (has-time, no-time), exercising the mirror `: -1` branch.
    const sections = groupSidebarItems(
      [],
      [
        conv({ conversationID: 'has-time', displayName: 'HasTime', updatedAt: '2026-05-01T00:00:00Z' }),
        conv({ conversationID: 'no-time', displayName: 'NoTime', updatedAt: undefined }),
      ],
      [],
      { conversationSort: 'recent' },
    );
    const dms = sections.find((s) => s.key === SidebarSectionKeys.DirectMessages)!;
    const ids = dms.items.map((i) => (i.kind === 'conversation' ? i.conversation.conversationID : ''));
    expect(ids).toEqual(['has-time', 'no-time']);
  });

  it('sorts az by display name', () => {
    const sections = groupSidebarItems(
      [],
      [conv({ conversationID: 'b', displayName: 'Bravo' }), conv({ conversationID: 'a', displayName: 'Alpha' })],
      [],
      { conversationSort: 'az' },
    );
    const dms = sections.find((s) => s.key === SidebarSectionKeys.DirectMessages)!;
    const names = dms.items.map((i) => (i.kind === 'conversation' ? i.conversation.displayName : ''));
    expect(names).toEqual(['Alpha', 'Bravo']);
  });
});

describe('groupSidebarItems: channel sort', () => {
  function chan(over: Partial<UserChannel>): UserChannel {
    return { channelID: 'ch', channelName: 'ch', channelType: 'public', role: 1, ...over } as UserChannel;
  }
  const channels = [
    chan({ channelID: 'alpha', channelName: 'alpha', sidebarPosition: 2000, lastMessageAt: '2026-10-29T12:00:00Z' }),
    chan({ channelID: 'bravo', channelName: 'bravo', sidebarPosition: 1000, lastMessageAt: '2026-10-29T09:00:00Z' }),
    chan({ channelID: 'quiet-b', channelName: 'Quiet-b' }),
    chan({ channelID: 'quiet-a', channelName: 'quiet-a' }),
    chan({ channelID: 'charlie', channelName: 'charlie', lastMessageAt: '2026-10-15T09:00:00Z', categoryID: 'work' }),
    chan({ channelID: 'delta', channelName: 'delta', lastMessageAt: '2026-10-20T09:00:00Z', categoryID: 'work' }),
    chan({ channelID: 'fav-old', channelName: 'fav-old', favorite: true, sidebarPosition: 1000, lastMessageAt: '2026-01-01T00:00:00Z' }),
    chan({ channelID: 'fav-new', channelName: 'fav-new', favorite: true, sidebarPosition: 2000, lastMessageAt: '2026-10-29T10:00:00Z' }),
  ];
  const ids = (sections: ReturnType<typeof groupSidebarItems>, key: string) =>
    sections.find((s) => s.key === key)!.items.map(sidebarItemID);

  it("defaults to the user's own order, then A-Z", () => {
    const sections = groupSidebarItems(channels, [], [cat({ id: 'work' })]);
    expect(ids(sections, SidebarSectionKeys.Channels)).toEqual(['bravo', 'alpha', 'quiet-a', 'quiet-b']);
    expect(ids(sections, 'work')).toEqual(['charlie', 'delta']);
  });

  it('puts the latest top-level message first, channels never posted in last (A-Z)', () => {
    const sections = groupSidebarItems(channels, [], [cat({ id: 'work' })], { channelSort: 'recent' });
    expect(ids(sections, SidebarSectionKeys.Channels)).toEqual(['alpha', 'bravo', 'quiet-a', 'quiet-b']);
    expect(ids(sections, 'work')).toEqual(['delta', 'charlie']);
    // Favorites keeps the hand-picked order whatever the channel sort.
    expect(ids(sections, SidebarSectionKeys.Favorites)).toEqual(['fav-old', 'fav-new']);
  });

  it('ignores hand-placed positions while sorting by recent activity', () => {
    const placed = [
      chan({ channelID: 'top-by-hand', channelName: 'a', sidebarPosition: 1000, lastMessageAt: '2026-10-01T00:00:00Z' }),
      chan({ channelID: 'busy', channelName: 'b', sidebarPosition: 9000, lastMessageAt: '2026-10-29T00:00:00Z' }),
    ];
    expect(ids(groupSidebarItems(placed, [], [], { channelSort: 'recent' }), SidebarSectionKeys.Channels)).toEqual([
      'busy',
      'top-by-hand',
    ]);
    expect(ids(groupSidebarItems(placed, [], [], { channelSort: 'az' }), SidebarSectionKeys.Channels)).toEqual([
      'top-by-hand',
      'busy',
    ]);
  });
});

describe('groupSidebarItems: unread view', () => {
  const ch = (over: Partial<UserChannel>): UserChannel =>
    ({ channelID: 'c', channelName: 'c', channelType: 'public', role: 1, ...over }) as UserChannel;
  const channels = [
    ch({ channelID: 'ch-read', channelName: 'read' }),
    ch({ channelID: 'ch-unread', channelName: 'unread', unread: true }),
    ch({ channelID: 'ch-muted', channelName: 'muted', unread: true, muted: true }),
    ch({ channelID: 'ch-mention', channelName: 'mention', unread: true, muted: true, unreadNotifyCount: 1 }),
    ch({ channelID: 'ch-fav', channelName: 'fav', unread: true, favorite: true }),
  ];
  const convs = [
    conv({ conversationID: 'dm-read', displayName: 'Read' }),
    conv({ conversationID: 'dm-alert', displayName: 'Alert', unreadNotifyCount: 2 }),
  ];
  const ids = (s: { items: SidebarItem[] }) => s.items.map(sidebarItemID);

  it('is off by default', () => {
    expect(groupSidebarItems(channels, convs, []).map((s) => s.key)).not.toContain(SidebarSectionKeys.Unread);
  });

  it('pulls unread chats into an Unread section at the top, in sidebar order', () => {
    const sections = groupSidebarItems(channels, convs, [], { unreadSection: true });
    expect(sections[0].key).toBe(SidebarSectionKeys.Unread);
    // muted without an alert stays put; a muted mention counts.
    expect(ids(sections[0])).toEqual(['ch-fav', 'ch-mention', 'ch-unread', 'dm-alert']);
    const channelsSection = sections.find((s) => s.key === SidebarSectionKeys.Channels)!;
    expect(ids(channelsSection)).toEqual(['ch-muted', 'ch-read']);
  });

  it('keeps the chat being viewed in Unread until the user leaves it', () => {
    const read = channels.map((c) => (c.channelID === 'ch-unread' ? { ...c, unread: false } : c));
    const sections = groupSidebarItems(read, convs, [], { unreadSection: true, stickyUnreadID: 'ch-unread' });
    expect(ids(sections[0])).toContain('ch-unread');
  });

  it('filters every section to unread chats, always keeping the one being viewed', () => {
    const sections = groupSidebarItems(channels, convs, [], { unreadOnly: true, activeID: 'dm-read' });
    expect(ids(sections.find((s) => s.key === SidebarSectionKeys.Channels)!)).toEqual(['ch-mention', 'ch-unread']);
    expect(ids(sections.find((s) => s.key === SidebarSectionKeys.DirectMessages)!)).toEqual(['dm-read', 'dm-alert']);
    expect(ids(sections.find((s) => s.key === SidebarSectionKeys.Favorites)!)).toEqual(['ch-fav']);
  });

  it('combines both: an Unread section, everything else filtered away', () => {
    const sections = groupSidebarItems(channels, convs, [], { unreadSection: true, unreadOnly: true });
    expect(ids(sections[0])).toHaveLength(4);
    expect(sections.slice(1).every((s) => s.items.length === 0)).toBe(true);
  });

  it('isSidebarItemUnread mirrors what the row shows', () => {
    expect(isSidebarItemUnread({ kind: 'conversation', conversation: conv({ unread: true }) })).toBe(true);
    expect(isSidebarItemUnread({ kind: 'conversation', conversation: conv({}) })).toBe(false);
    expect(isSidebarItemUnread({ kind: 'channel', channel: ch({ unread: true, muted: true }) })).toBe(false);
  });
});

describe('archived channels', () => {
  const ch = (over: Partial<UserChannel>): UserChannel =>
    ({ channelID: 'x', channelName: 'x', channelType: 'public', role: 1, ...over }) as UserChannel;

  it('groupSidebarItems leaves archived channels out of every section, even favorites/categories/unread', () => {
    const sections = groupSidebarItems(
      [
        ch({ channelID: 'live', channelName: 'live' }),
        ch({ channelID: 'old-fav', channelName: 'old-fav', archived: true, favorite: true }),
        ch({ channelID: 'old-cat', channelName: 'old-cat', archived: true, categoryID: 'cat' }),
        ch({ channelID: 'old-unread', channelName: 'old-unread', archived: true, unread: true }),
      ],
      [],
      [cat({ id: 'cat' })],
      { unreadSection: true },
    );
    const ids = sections.flatMap((s) => s.items.map(sidebarItemID));
    expect(ids).toEqual(['live']);
  });

  it('archivedSidebarChannels returns only archived channels, A-Z', () => {
    const out = archivedSidebarChannels([
      ch({ channelID: 'b', channelName: 'Beta', archived: true }),
      ch({ channelID: 'live', channelName: 'live' }),
      ch({ channelID: 'a', channelName: 'alpha', archived: true }),
    ]);
    expect(out.map((c) => c.channelID)).toEqual(['a', 'b']);
  });
});
