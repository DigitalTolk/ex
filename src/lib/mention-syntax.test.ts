import { describe, it, expect } from 'vitest';
import cases from '../../internal/service/testdata/mention_scan_cases.json';
import {
  isUserGroupId,
  mentionTokenFromMatch,
  replaceMentions,
  scanMentions,
  USER_GROUP_ID_PREFIX,
} from './mention-syntax';
import { toPlainTextPreview } from './message-preview';
import { markdownToHast } from './markdown-to-hast';
import {
  nonMemberGroupMentions,
  nonMemberMentions,
  typedUserGroupMentions,
  userGroupTokens,
} from './non-member-mentions';
import { isValidUserGroupHandle, suggestUserGroupHandle } from './limits';
import type { HastNode } from '@/types';

interface FixtureCase {
  name: string;
  text: string;
  tokens: { kind: string; id: string; label: string; raw: string }[];
}

// The Go scanner (ScanMentions) runs the very same cases.
describe('scanMentions — shared fixture', () => {
  for (const tc of cases as FixtureCase[]) {
    it(tc.name, () => {
      const got = scanMentions(tc.text).map((t) => ({ kind: t.kind, id: t.id, label: t.label, raw: tc.text.slice(t.start, t.end) }));
      expect(got).toEqual(tc.tokens);
    });
  }

  it('uses UTF-16 offsets after an emoji', () => {
    const text = '👋🏽 @[group-G|ops]';
    const [t] = scanMentions(text);
    expect(text.slice(t.start, t.end)).toBe('@[group-G|ops]');
    expect(t.start).toBe('👋🏽 '.length);
  });
});

describe('mention-syntax helpers', () => {
  it('classifies IDs by the user-group prefix', () => {
    expect(USER_GROUP_ID_PREFIX).toBe('group-');
    expect(isUserGroupId('group-01J')).toBe(true);
    expect(isUserGroupId('01JGROUP')).toBe(false);
    expect(isUserGroupId('bot-group-x')).toBe(false);
  });

  it('reads a match without an index as starting at 0', () => {
    const m = Object.assign(['@[a|b]', 'a', 'b'], {}) as unknown as RegExpMatchArray;
    expect(mentionTokenFromMatch(m)).toEqual({ start: 0, end: 6, kind: 'user', id: 'a', label: 'b' });
  });

  it('replaces every token', () => {
    expect(replaceMentions('a @[U1|Ann] b @[group-G|ops] c', (t) => `<${t.kind}:${t.id}>`)).toBe('a <user:U1> b <usergroup:group-G> c');
    expect(replaceMentions('plain', () => 'x')).toBe('plain');
  });
});

describe('readers of the mention token', () => {
  it('previews a group mention as its handle', () => {
    expect(toPlainTextPreview('ping @[group-G|oncall] and @[U1|Ann]')).toBe('ping @oncall and @Ann');
  });

  it('parses a group token into an ex-mention-usergroup element', () => {
    const tree = markdownToHast('ping @[group-G|oncall] and @[U1| Ann ]');
    const found: HastNode[] = [];
    const walk = (n: HastNode) => {
      if (n.type === 'element' && n.tagName?.startsWith('ex-mention')) found.push(n);
      (n.children ?? []).forEach(walk);
    };
    walk(tree);
    expect(found.map((n) => [n.tagName, n.properties])).toEqual([
      ['ex-mention-usergroup', { 'data-usergroup-id': 'group-G', 'data-handle': 'oncall', 'data-value': '@[group-G|oncall]' }],
      ['ex-mention-user', { 'data-user-id': 'U1', 'data-name': 'Ann', 'data-value': '@[U1| Ann ]' }],
    ]);
  });

  it('never offers a group token as a person to invite', () => {
    expect(nonMemberMentions('@[group-G|oncall] @[U1|Ann]', new Set())).toEqual([{ id: 'U1', displayName: 'Ann' }]);
  });
});

describe('user-group invite helpers', () => {
  it('lists the group tokens once each', () => {
    expect(userGroupTokens('@[group-A| oncall ] @[group-A|oncall] @[group-B|sre] @[U1|x]')).toEqual([
      { id: 'group-A', handle: 'oncall' },
      { id: 'group-B', handle: 'sre' },
    ]);
  });

  it("finds each group's members outside the channel", () => {
    const members: Record<string, string[]> = { 'group-A': ['me', 'in', 'out1', 'gone'], 'group-B': ['in'] };
    const got = nonMemberGroupMentions(
      [{ id: 'group-A', handle: 'oncall' }, { id: 'group-B', handle: 'sre' }, { id: 'group-C', handle: 'unknown' }],
      new Set(['in']),
      (id) => members[id],
      'me',
      (id) => id === 'gone',
    );
    expect(got).toEqual([{ groupId: 'group-A', handle: 'oncall', missingUserIds: ['out1'] }]);
    // Without an inactive check, everyone outside counts.
    expect(nonMemberGroupMentions([{ id: 'group-A', handle: 'oncall' }], new Set(), (id) => members[id])[0].missingUserIds).toEqual([
      'me',
      'in',
      'out1',
      'gone',
    ]);
  });

  it('recognises typed handles of known groups, outside code', () => {
    const groups = [
      { id: 'group-A', handle: 'oncall' },
      { id: 'group-B', handle: 'sre.team' },
    ];
    expect(typedUserGroupMentions('ping @OnCall. and @sre.team, also @oncall', groups)).toEqual(groups);
    expect(typedUserGroupMentions('`@oncall` ops@oncall https://x.com/@oncall', groups)).toEqual([]);
    expect(typedUserGroupMentions('no handles', groups)).toEqual([]);
    expect(typedUserGroupMentions('@oncall', [])).toEqual([]);
  });
});

describe('user-group handle rules', () => {
  it('suggests a handle from a name', () => {
    expect(suggestUserGroupHandle('On-call Engineers!')).toBe('on-call-engineers');
    expect(suggestUserGroupHandle('  --Design  ')).toBe('design');
    expect(suggestUserGroupHandle('x'.repeat(40))).toHaveLength(30);
  });

  it('validates handles like the server', () => {
    expect(isValidUserGroupHandle('oncall')).toBe(true);
    expect(isValidUserGroupHandle('a')).toBe(false);
    expect(isValidUserGroupHandle('-x')).toBe(false);
    expect(isValidUserGroupHandle('here')).toBe(false);
  });
});
