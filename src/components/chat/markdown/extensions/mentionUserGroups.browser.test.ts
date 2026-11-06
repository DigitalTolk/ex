import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { rankUsers, type MentionUserGroup } from './mentionData';
import { userMentionSource, type MentionProviders } from './mentionAutocomplete';
import { mentionPills } from './mentionPills';
import type { MentionCompletion } from './optionRender';

const GROUPS: MentionUserGroup[] = [
  { id: 'group-1', handle: 'oncall', name: 'On-call engineers', memberCount: 5 },
  { id: 'group-2', handle: 'design', name: 'Design', memberCount: 1 },
  { id: 'group-3', handle: 'sre', name: 'Ops on call', memberCount: 3 },
];

const base: MentionProviders = {
  users: () => [{ id: 'u1', displayName: 'Olive' }],
  online: () => new Set(),
  memberIds: () => null,
  channels: () => [],
  userGroups: () => GROUPS,
};

function ctxFor(doc: string): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), doc.length, false);
}

function sectionName(o: { section?: string | { name: string } }): string | undefined {
  return typeof o.section === 'string' ? o.section : o.section?.name;
}

describe('rankUsers with user groups', () => {
  it('matches a handle or name prefix, handle matches first, then by handle', () => {
    const hits = rankUsers('o', { users: [], online: new Set(), memberIds: null, userGroups: GROUPS });
    expect(hits.map((h) => (h.kind === 'usergroup' ? h.handle : ''))).toEqual(['oncall', 'sre']);
  });

  it('lists every group for a bare "@", sorted by handle', () => {
    const hits = rankUsers('', { users: [], online: new Set(), memberIds: null, userGroups: GROUPS });
    expect(hits.map((h) => (h.kind === 'usergroup' ? h.handle : ''))).toEqual(['design', 'oncall', 'sre']);
  });

  it('places groups after @all/@here and before non-members in a channel', () => {
    const hits = rankUsers('o', {
      users: [{ id: 'u1', displayName: 'Olive' }, { id: 'u2', displayName: 'Oscar' }],
      online: new Set(),
      memberIds: new Set(['u1']),
      userGroups: GROUPS,
    });
    expect(hits.map((h) => (h.kind === 'user' ? h.displayName : h.kind === 'usergroup' ? `@${h.handle}` : h.group))).toEqual([
      'Olive',
      '@oncall',
      '@sre',
      'Oscar',
    ]);
  });

  it('offers no groups when none are given', () => {
    expect(rankUsers('o', { users: [], online: new Set(), memberIds: null }).filter((h) => h.kind === 'usergroup')).toEqual([]);
  });
});

describe('userMentionSource with user groups', () => {
  it('inserts the group token and describes the group', () => {
    const res = userMentionSource(base)(ctxFor('ping @onc')) as CompletionResult;
    const opt = res.options.find((o) => o.label === '@oncall') as MentionCompletion;
    expect(opt.detail).toBe('On-call engineers · 5 members');
    expect(opt.meta).toEqual({ kind: 'group', title: '@oncall', description: 'On-call engineers · 5 members' });
    expect(opt.section).toBeUndefined();

    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: 'ping @onc' }) });
    (opt.apply as (v: EditorView, c: MentionCompletion, from: number, to: number) => void)(view, opt, res.from, res.to);
    expect(view.state.doc.toString()).toBe('ping @[group-1|oncall] ');
    view.destroy();
  });

  it('says "1 member" for a group of one', () => {
    const res = userMentionSource(base)(ctxFor('@des')) as CompletionResult;
    expect(res.options.find((o) => o.label === '@design')?.detail).toBe('Design · 1 member');
  });

  it('groups them under "User groups" in a channel', () => {
    const res = userMentionSource({ ...base, memberIds: () => new Set(['u1']) })(ctxFor('@onc')) as CompletionResult;
    expect(sectionName(res.options.find((o) => o.label === '@oncall')!)).toBe('User groups');
  });

  it('offers no groups when the providers have none', () => {
    const res = userMentionSource({ ...base, userGroups: undefined })(ctxFor('@onc')) as CompletionResult;
    expect(res.options.some((o) => o.label === '@oncall')).toBe(false);
  });
});

describe('mentionPills with user groups', () => {
  it('renders a user-group token as a usergroup pill showing @handle', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: 'ping @[group-1|oncall] and @[u-1|Ann]', extensions: [mentionPills] }),
    });
    view.dispatch({ selection: EditorSelection.cursor(0) });
    const pills = Array.from(view.dom.querySelectorAll('.cm-mention-pill'));
    expect(pills.map((p) => [p.textContent, p.getAttribute('data-mention-kind')])).toEqual([
      ['@oncall', 'usergroup'],
      ['@Ann', 'user'],
    ]);
    view.destroy();
  });
});
