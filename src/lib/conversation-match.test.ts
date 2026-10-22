import { describe, expect, it } from 'vitest';
import { conversationsWith, groupsMatching } from './conversation-match';
import type { UserConversation } from '@/types';

const conv = (id: string, type: 'dm' | 'group', displayName: string, participantIDs: string[], updatedAt = '2026-05-01T10:00:00Z') =>
  ({ userID: 'me', conversationID: id, type, displayName, participantIDs, activated: true, joinedAt: '2026-01-01T00:00:00Z', updatedAt }) as UserConversation;

const all = [
  conv('dm-alice', 'dm', 'Alice Example', ['me', 'alice']),
  conv('g-ab', 'group', 'Alice Example, Bob Builder', ['me', 'alice', 'bob']),
  conv('g-abc', 'group', 'Alice Example, Bob Builder, Chloé Doe', ['me', 'alice', 'bob', 'chloe']),
  conv('g-ab-old', 'group', 'Alice Example, Bob Builder, Zed', ['me', 'alice', 'bob', 'zed'], '2026-04-01T10:00:00Z'),
  conv('g-ab-new', 'group', 'Alice Example, Bob Builder, Yan', ['me', 'alice', 'bob', 'yan'], '2026-06-01T10:00:00Z'),
];

describe('groupsMatching', () => {
  it('finds the groups everyone named is in, the smallest and then the latest first', () => {
    expect(groupsMatching(all, 'ali bob').map((c) => c.conversationID)).toEqual(['g-ab', 'g-ab-new', 'g-abc', 'g-ab-old']);
  });

  it('matches the start of any name, ignoring case, accents and commas', () => {
    expect(groupsMatching(all, 'CHLOE, builder').map((c) => c.conversationID)).toEqual(['g-abc']);
    expect(groupsMatching(all, 'lice')).toEqual([]);
  });

  it('leaves out DMs, and stops at the limit', () => {
    expect(groupsMatching(all, 'alice', 2).map((c) => c.conversationID)).toEqual(['g-ab', 'g-ab-new']);
  });

  it('puts a group with no activity time after the others its size', () => {
    const quiet = { ...conv('g-quiet', 'group', 'Alice Example, Bob Builder', ['me', 'alice', 'bob']), updatedAt: undefined } as unknown as UserConversation;
    const quieter = { ...quiet, conversationID: 'g-quieter' } as UserConversation;
    expect(groupsMatching([quiet, all[1], quieter], 'alice bob').map((c) => c.conversationID)).toEqual(['g-ab', 'g-quiet', 'g-quieter']);
  });

  it('finds nothing for nothing typed', () => {
    expect(groupsMatching(all, ' , ')).toEqual([]);
  });
});

describe('conversationsWith', () => {
  it('lists every conversation with all the people, the one with exactly them first', () => {
    const got = conversationsWith(all, ['bob', 'alice'], 'me');
    expect(got.map((m) => [m.conversation.conversationID, m.exact])).toEqual([
      ['g-ab', true],
      ['g-ab-new', false],
      ['g-abc', false],
      ['g-ab-old', false],
    ]);
  });

  it('finds the DM for one person', () => {
    expect(conversationsWith(all, ['alice'], 'me')[0]).toEqual({ conversation: all[0], exact: true });
  });

  it('lists nothing before anyone is picked, or with no one known as you', () => {
    expect(conversationsWith(all, [], 'me')).toEqual([]);
    expect(conversationsWith(all, ['chloe'], undefined).map((m) => m.exact)).toEqual([false]);
  });

  it('reads a conversation with no participant list as nobody', () => {
    const bare = { ...all[1], participantIDs: undefined } as unknown as UserConversation;
    expect(conversationsWith([bare], ['alice'], 'me')).toEqual([]);
    expect(groupsMatching([bare, all[2]], 'alice').map((c) => c.conversationID)).toEqual(['g-ab', 'g-abc']);
  });
});
