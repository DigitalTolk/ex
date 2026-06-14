import { describe, it, expect } from 'vitest';
import type { UserConversation, SidebarCategory } from '@/types';
import { groupSidebarItems, SidebarSectionKeys } from './sidebar-groups';

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
