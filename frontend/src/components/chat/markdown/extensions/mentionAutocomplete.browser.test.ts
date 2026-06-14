import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import {
  userMentionSource,
  channelMentionSource,
  type MentionProviders,
} from './mentionAutocomplete';

const providers: MentionProviders = {
  users: () => [
    { id: 'u1', displayName: 'Alice', email: 'alice@x.test' },
    { id: 'u2', displayName: 'Bob' },
  ],
  online: () => new Set(['u1']),
  memberIds: () => null,
  channels: () => [
    { channelID: 'c1', channelName: 'general', channelType: 'public' },
    { channelID: 'c2', channelName: 'secret', channelType: 'private' },
  ],
};

// Build a CompletionContext with the caret at the end of `doc`.
function ctxFor(doc: string, explicit = false): CompletionContext {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, doc.length, explicit);
}

function makeView(doc: string): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView({ parent: host, state: EditorState.create({ doc }) });
}

describe('userMentionSource', () => {
  it('returns ranked user options for a @query at a boundary', () => {
    const res = userMentionSource(providers)(ctxFor('hi @al')) as CompletionResult;
    expect(res).not.toBeNull();
    expect(res.from).toBe(3);
    expect(res.filter).toBe(false);
    expect(res.options[0].label).toBe('Alice');
    expect(res.options[0].detail).toBe('alice@x.test');
  });

  it('opens on a bare @ (empty query → full roster)', () => {
    const res = userMentionSource(providers)(ctxFor('@')) as CompletionResult;
    expect(res.options.map((o) => o.label)).toEqual(['Alice', 'Bob']);
  });

  it('does not trigger when @ is inside a word (e.g. an email)', () => {
    expect(userMentionSource(providers)(ctxFor('mail@'))).toBeNull();
  });

  it('returns null when there is no @ before the caret', () => {
    expect(userMentionSource(providers)(ctxFor('plain text'))).toBeNull();
  });

  it('inserts the canonical @[id|name] token with a trailing space on apply', () => {
    const view = makeView('hi @al');
    view.dispatch({ selection: { anchor: 6 } });
    const res = userMentionSource(providers)(
      new CompletionContext(view.state, 6, false),
    ) as CompletionResult;
    const opt = res.options[0];
    (opt.apply as (v: EditorView, c: typeof opt, f: number, t: number) => void)(view, opt, res.from, res.to);
    expect(view.state.doc.toString()).toBe('hi @[u1|Alice] ');
    view.destroy();
  });

  it('inserts a @group token for @all', () => {
    const view = makeView('@all');
    const res = userMentionSource(providers)(new CompletionContext(view.state, 4, false)) as CompletionResult;
    const group = res.options.find((o) => o.label === '@all')!;
    (group.apply as (v: EditorView, c: typeof group, f: number, t: number) => void)(view, group, res.from, res.to);
    expect(view.state.doc.toString()).toBe('@all ');
    view.destroy();
  });
});

describe('channelMentionSource', () => {
  it('returns ranked channel options, public typed variable', () => {
    const res = channelMentionSource(providers)(ctxFor('see ~gen')) as CompletionResult;
    expect(res.options[0].label).toBe('~general');
    expect(res.options[0].type).toBe('variable');
  });

  it('marks private channels with the class type', () => {
    const res = channelMentionSource(providers)(ctxFor('~sec')) as CompletionResult;
    expect(res.options[0].label).toBe('~secret');
    expect(res.options[0].type).toBe('class');
  });

  it('returns null when ~ is inside a word', () => {
    expect(channelMentionSource(providers)(ctxFor('a~b'))).toBeNull();
  });

  it('returns null when there is no ~ before the caret', () => {
    expect(channelMentionSource(providers)(ctxFor('nothing'))).toBeNull();
  });

  it('triggers at the very start of the document (boundary at pos 0)', () => {
    const res = channelMentionSource(providers)(ctxFor('~gen')) as CompletionResult;
    expect(res.from).toBe(0);
    expect(res.options[0].label).toBe('~general');
  });

  it('inserts the canonical ~[id|slug] token on apply', () => {
    const view = makeView('see ~gen');
    const res = channelMentionSource(providers)(new CompletionContext(view.state, 8, false)) as CompletionResult;
    const opt = res.options[0];
    (opt.apply as (v: EditorView, c: typeof opt, f: number, t: number) => void)(view, opt, res.from, res.to);
    expect(view.state.doc.toString()).toBe('see ~[c1|general] ');
    view.destroy();
  });
});
