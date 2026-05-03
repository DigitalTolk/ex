import { describe, it, expect } from 'vitest';
import { groupSidebarItems, SidebarSectionKeys } from '@/lib/sidebar-groups';
import type { UserChannel, UserConversation, SidebarCategory } from '@/types';

const ch = (overrides: Partial<UserChannel> = {}): UserChannel => ({
  channelID: 'c-' + Math.random().toString(36).slice(2, 8),
  channelName: 'general',
  channelType: 'public',
  role: 1,
  ...overrides,
});

const cat = (id: string, name: string, position = 0): SidebarCategory => ({
  id,
  name,
  position,
});

const conv = (overrides: Partial<UserConversation> = {}): UserConversation => ({
  conversationID: 'conv-' + Math.random().toString(36).slice(2, 8),
  type: 'dm',
  displayName: 'Bob',
  ...overrides,
});

describe('groupSidebarItems', () => {
  it('emits five sections in order: Favorites, categories, Channels, Direct Messages', () => {
    const sections = groupSidebarItems(
      [ch({ channelID: 'ch-1' })],
      [conv({ conversationID: 'c-1' })],
      [cat('c1', 'Engineering', 1)],
    );
    expect(sections.map((s) => s.title)).toEqual([
      'Favorites',
      'Engineering',
      'Channels',
      'Direct Messages',
    ]);
  });

  it('mixes channels and DMs in Favorites', () => {
    const sections = groupSidebarItems(
      [ch({ channelID: 'ch-fav', favorite: true })],
      [conv({ conversationID: 'c-fav', favorite: true })],
      [],
    );
    const fav = sections.find((s) => s.title === 'Favorites');
    expect(fav?.items.map((i) => i.kind).sort()).toEqual(['channel', 'conversation']);
  });

  it('mixes channels and DMs inside a user category', () => {
    const sections = groupSidebarItems(
      [ch({ channelID: 'ch-1', categoryID: 'eng' })],
      [conv({ conversationID: 'c-1', categoryID: 'eng' })],
      [cat('eng', 'Engineering')],
    );
    const eng = sections.find((s) => s.title === 'Engineering');
    expect(eng?.items).toHaveLength(2);
    expect(eng?.items.map((i) => i.kind).sort()).toEqual(['channel', 'conversation']);
  });

  it('puts uncategorised channels under "Channels" and uncategorised DMs under "Direct Messages"', () => {
    const sections = groupSidebarItems(
      [ch({ channelID: 'ch-x' })],
      [conv({ conversationID: 'c-x' })],
      [],
    );
    const channels = sections.find((s) => s.title === 'Channels');
    const dms = sections.find((s) => s.title === 'Direct Messages');
    expect(channels?.items).toHaveLength(1);
    expect(channels?.items[0].kind).toBe('channel');
    expect(dms?.items).toHaveLength(1);
    expect(dms?.items[0].kind).toBe('conversation');
  });

  it('does not duplicate a favorited DM under its category', () => {
    const sections = groupSidebarItems(
      [],
      [conv({ conversationID: 'c-1', favorite: true, categoryID: 'eng' })],
      [cat('eng', 'Engineering')],
    );
    const fav = sections.find((s) => s.title === 'Favorites');
    const eng = sections.find((s) => s.title === 'Engineering');
    expect(fav?.items).toHaveLength(1);
    expect(eng?.items).toHaveLength(0);
  });

  it('routes DMs with stale categoryID to the Direct Messages default', () => {
    const sections = groupSidebarItems(
      [],
      [conv({ conversationID: 'orphan', categoryID: 'deleted' })],
      [cat('alive', 'Alive')],
    );
    const dms = sections.find((s) => s.title === 'Direct Messages');
    expect(dms?.items.map((i) => (i.kind === 'conversation' ? i.conversation.conversationID : ''))).toEqual([
      'orphan',
    ]);
  });

  it('orders channels by saved sidebar position', () => {
    const sections = groupSidebarItems(
      [
        ch({ channelID: 'late', channelName: 'late', sidebarPosition: 2000 }),
        ch({ channelID: 'early', channelName: 'early', sidebarPosition: 1000 }),
      ],
      [],
      [],
    );
    const channels = sections.find((s) => s.key === SidebarSectionKeys.Channels);
    expect(channels?.items.map((i) => (i.kind === 'channel' ? i.channel.channelID : ''))).toEqual([
      'early',
      'late',
    ]);
  });

  it('sorts direct messages by recent activity by default and A-Z on request', () => {
    const recent = groupSidebarItems(
      [],
      [
        conv({ conversationID: 'old', displayName: 'Zoe', updatedAt: '2026-05-01T10:00:00Z' }),
        conv({ conversationID: 'new', displayName: 'Amy', updatedAt: '2026-05-02T10:00:00Z' }),
      ],
      [],
    );
    expect(
      recent
        .find((s) => s.key === SidebarSectionKeys.DirectMessages)
        ?.items.map((i) => (i.kind === 'conversation' ? i.conversation.conversationID : '')),
    ).toEqual(['new', 'old']);

    const az = groupSidebarItems(
      [],
      [
        conv({ conversationID: 'zoe', displayName: 'Zoe', updatedAt: '2026-05-02T10:00:00Z' }),
        conv({ conversationID: 'amy', displayName: 'Amy', updatedAt: '2026-05-01T10:00:00Z' }),
      ],
      [],
      { conversationSort: 'az' },
    );
    expect(
      az
        .find((s) => s.key === SidebarSectionKeys.DirectMessages)
        ?.items.map((i) => (i.kind === 'conversation' ? i.conversation.conversationID : '')),
    ).toEqual(['amy', 'zoe']);
  });

  it('exposes stable section keys via SidebarSectionKeys', () => {
    const sections = groupSidebarItems([], [], []);
    const keys = sections.map((s) => s.key);
    expect(keys).toContain(SidebarSectionKeys.Favorites);
    expect(keys).toContain(SidebarSectionKeys.Channels);
    expect(keys).toContain(SidebarSectionKeys.DirectMessages);
  });
});
