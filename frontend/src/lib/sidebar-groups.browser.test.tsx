import { describe, expect, it } from 'vitest';
import { groupSidebarItems, SidebarSectionKeys } from './sidebar-groups';
import type { UserChannel, UserConversation, SidebarCategory } from '@/types';

const channel = (overrides: Partial<UserChannel> = {}): UserChannel => ({
  channelID: 'ch-1',
  channelName: 'general',
  channelType: 'public',
  muted: false,
  favorite: false,
  categoryID: '',
  unreadCount: 0,
  ...overrides,
});

const conversation = (overrides: Partial<UserConversation> = {}): UserConversation => ({
  conversationID: 'cv-1',
  type: 'dm',
  displayName: 'Bob',
  participantIDs: ['u-1', 'u-2'],
  unreadCount: 0,
  favorite: false,
  categoryID: '',
  ...overrides,
});

describe('groupSidebarItems', () => {
  it('emits Favorites, Channels and Direct Messages sections by default', () => {
    const sections = groupSidebarItems([channel()], [conversation()], []);
    expect(sections.map((s) => s.key)).toEqual([
      SidebarSectionKeys.Favorites,
      SidebarSectionKeys.Channels,
      SidebarSectionKeys.DirectMessages,
    ]);
  });

  it('places favorited items only under Favorites and not under category/default', () => {
    const sections = groupSidebarItems(
      [
        channel({ channelID: 'ch-1', favorite: true, channelName: 'alpha' }),
        channel({ channelID: 'ch-2', channelName: 'beta' }),
      ],
      [conversation({ favorite: true, displayName: 'Alice' })],
      [],
    );
    const favs = sections.find((s) => s.key === SidebarSectionKeys.Favorites)!;
    expect(favs.items.length).toBe(2);
    const channels = sections.find((s) => s.key === SidebarSectionKeys.Channels)!;
    expect(channels.items.map((i) => (i.kind === 'channel' ? i.channel.channelID : ''))).toEqual(['ch-2']);
  });

  it('groups items by user category in position order, falling back to id', () => {
    const categories: SidebarCategory[] = [
      { id: 'c-2', name: 'Z group', position: 0 },
      { id: 'c-1', name: 'A group', position: 0 },
    ];
    const sections = groupSidebarItems(
      [
        channel({ channelID: 'ch-1', categoryID: 'c-1' }),
        channel({ channelID: 'ch-2', categoryID: 'c-2' }),
      ],
      [],
      categories,
    );
    const userKeys = sections.map((s) => s.key);
    expect(userKeys[1]).toBe('c-1'); // 'c-1' sorts before 'c-2' on tie
    expect(userKeys[2]).toBe('c-2');
  });

  it('falls through to the default channels section when categoryID points at a deleted category', () => {
    const sections = groupSidebarItems(
      [channel({ channelID: 'ch-x', categoryID: 'deleted' })],
      [],
      [],
    );
    const def = sections.find((s) => s.key === SidebarSectionKeys.Channels)!;
    expect(def.items.length).toBe(1);
  });

  it('sorts conversations by az when conversationSort=az', () => {
    const sections = groupSidebarItems(
      [],
      [
        conversation({ conversationID: 'cv-z', displayName: 'Zane', updatedAt: '2026-01-02T00:00:00Z' }),
        conversation({ conversationID: 'cv-a', displayName: 'Alice', updatedAt: '2026-01-01T00:00:00Z' }),
      ],
      [],
      { conversationSort: 'az' },
    );
    const dms = sections.find((s) => s.key === SidebarSectionKeys.DirectMessages)!;
    const ids = dms.items.map((i) => (i.kind === 'conversation' ? i.conversation.conversationID : ''));
    expect(ids).toEqual(['cv-a', 'cv-z']);
  });

  it('sorts conversations by updatedAt desc when conversationSort=recent (default)', () => {
    const sections = groupSidebarItems(
      [],
      [
        conversation({ conversationID: 'cv-a', displayName: 'A', updatedAt: '2026-01-01T00:00:00Z' }),
        conversation({ conversationID: 'cv-b', displayName: 'B', updatedAt: '2026-01-02T00:00:00Z' }),
      ],
      [],
    );
    const dms = sections.find((s) => s.key === SidebarSectionKeys.DirectMessages)!;
    const ids = dms.items.map((i) => (i.kind === 'conversation' ? i.conversation.conversationID : ''));
    expect(ids).toEqual(['cv-b', 'cv-a']);
  });

  it('respects sparse sidebarPosition before falling back to alphabetical', () => {
    const sections = groupSidebarItems(
      [
        channel({ channelID: 'ch-a', channelName: 'aaa', sidebarPosition: 0 }),
        channel({ channelID: 'ch-b', channelName: 'bbb', sidebarPosition: 1 }),
        channel({ channelID: 'ch-c', channelName: 'ccc', sidebarPosition: 2 }),
      ],
      [],
      [],
    );
    const def = sections.find((s) => s.key === SidebarSectionKeys.Channels)!;
    const ids = def.items.map((i) => (i.kind === 'channel' ? i.channel.channelID : ''));
    expect(ids[0]).toBe('ch-b');
    expect(ids[1]).toBe('ch-c');
    expect(ids[2]).toBe('ch-a');
  });
});
