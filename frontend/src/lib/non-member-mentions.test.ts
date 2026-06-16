import { describe, it, expect } from 'vitest';
import { nonMemberMentions } from './non-member-mentions';

describe('nonMemberMentions', () => {
  it('returns mentioned users who are not channel members', () => {
    const body = 'hey @[u-jeff|Jeff Bozo] and @[u-alice|Alice] ship it';
    const members = new Set(['u-me', 'u-alice']);
    expect(nonMemberMentions(body, members, 'u-me')).toEqual([{ id: 'u-jeff', displayName: 'Jeff Bozo' }]);
  });

  it('collects multiple non-members and de-dupes repeats', () => {
    const body = '@[u-a|A] @[u-b|B] @[u-a|A] again';
    expect(nonMemberMentions(body, new Set(), undefined)).toEqual([
      { id: 'u-a', displayName: 'A' },
      { id: 'u-b', displayName: 'B' },
    ]);
  });

  it('skips the author, members, and group mentions', () => {
    const body = '@[u-me|Me] @[u-alice|Alice] @all @here please';
    const members = new Set(['u-alice']);
    expect(nonMemberMentions(body, members, 'u-me')).toEqual([]);
  });

  it('returns [] when there are no user mentions', () => {
    expect(nonMemberMentions('no mentions here', new Set())).toEqual([]);
  });
});
