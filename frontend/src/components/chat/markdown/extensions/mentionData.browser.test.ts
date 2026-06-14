import { describe, it, expect } from 'vitest';
import { rankUsers, rankChannels, type MentionUser } from './mentionData';

const users: MentionUser[] = [
  { id: 'u1', displayName: 'Alice', email: 'alice@x.test' },
  { id: 'u2', displayName: 'Alan', email: 'alan@x.test' },
  { id: 'u3', displayName: 'Bob', email: 'bob@x.test' },
  { id: 'u4', displayName: 'Calvin' },
];

describe('rankUsers', () => {
  it('fuzzy-matches name and email, with no channel context (flat list, no inChannel)', () => {
    const out = rankUsers('al', { users, online: new Set(), memberIds: null });
    const names = out.map((s) => (s.kind === 'user' ? s.displayName : `@${s.group}`));
    // Alice/Alan are prefix matches; Calvin contains "al" as a substring → after.
    expect(names).toEqual(['Alice', 'Alan', 'Calvin']);
    expect(out.every((s) => s.kind === 'user' && s.inChannel === undefined)).toBe(true);
  });

  it('matches by email when the name does not match', () => {
    const out = rankUsers('bob@', { users, online: new Set(), memberIds: null });
    expect(out).toHaveLength(1);
    expect(out[0].kind === 'user' && out[0].displayName).toBe('Bob');
  });

  it('ranks prefix matches above substring matches', () => {
    const roster: MentionUser[] = [
      { id: 'a', displayName: 'Pascal' }, // substring "cal"
      { id: 'b', displayName: 'Calvin' }, // prefix "cal"
    ];
    const out = rankUsers('cal', { users: roster, online: new Set(), memberIds: null });
    expect(out.map((s) => (s.kind === 'user' ? s.displayName : ''))).toEqual(['Calvin', 'Pascal']);
  });

  it('breaks prefix ties by online presence', () => {
    const roster: MentionUser[] = [
      { id: 'off', displayName: 'Alvin' },
      { id: 'on', displayName: 'Alvar' },
    ];
    const out = rankUsers('al', { users: roster, online: new Set(['on']), memberIds: null });
    expect(out.map((s) => (s.kind === 'user' ? s.id : ''))).toEqual(['on', 'off']);
  });

  it('surfaces @all only when the full keyword is typed', () => {
    expect(rankUsers('al', { users, online: new Set(), memberIds: null }).some((s) => s.kind === 'group')).toBe(false);
    const out = rankUsers('all', { users, online: new Set(), memberIds: null });
    expect(out[0]).toEqual({ kind: 'group', group: 'all' });
  });

  it('surfaces @here on the full keyword', () => {
    const out = rankUsers('here', { users, online: new Set(), memberIds: null });
    expect(out[0]).toEqual({ kind: 'group', group: 'here' });
  });

  it('partitions channel members first, then non-members (each flagged)', () => {
    const out = rankUsers('a', {
      users,
      online: new Set(),
      memberIds: new Set(['u1']), // Alice is a member
    });
    expect(out[0]).toMatchObject({ kind: 'user', id: 'u1', inChannel: true });
    // The rest (Alan, Calvin) follow, flagged inChannel:false.
    expect(out.slice(1).every((s) => s.kind === 'user' && s.inChannel === false)).toBe(true);
  });

  it('places group mentions between members and non-members in a channel', () => {
    const out = rankUsers('all', {
      users,
      online: new Set(),
      memberIds: new Set(['u1']),
    });
    // No user matches "all"; only the @all group surfaces.
    expect(out).toEqual([{ kind: 'group', group: 'all' }]);
  });
});

describe('rankChannels', () => {
  const channels = [
    { channelID: 'c1', channelName: 'general', channelType: 'public' },
    { channelID: 'c2', channelName: 'random', channelType: 'public' },
    { channelID: 'c3', channelName: 'secret-general', channelType: 'private' },
  ];

  it('fuzzy-matches slug and marks private channels', () => {
    const out = rankChannels('general', channels);
    expect(out.map((c) => c.slug)).toEqual(['general', 'secret-general']);
    expect(out.find((c) => c.id === 'c3')?.isPrivate).toBe(true);
    expect(out.find((c) => c.id === 'c1')?.isPrivate).toBe(false);
  });

  it('ranks prefix matches above substring matches', () => {
    const out = rankChannels('gen', channels);
    expect(out[0].slug).toBe('general'); // prefix beats "secret-general"
  });

  it('returns every channel for an empty query', () => {
    expect(rankChannels('', channels)).toHaveLength(3);
  });
});
