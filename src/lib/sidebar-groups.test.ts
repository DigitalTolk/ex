import { describe, it, expect } from 'vitest';
import type { UserChannel, UserConversation, SidebarCategory } from '@/types';
import { groupSidebarItems, isSidebarItemUnread, sidebarItemID, SidebarSectionKeys, type SidebarItem } from './sidebar-groups';

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
