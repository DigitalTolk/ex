import { describe, expect, it } from 'vitest';
import { classifyParentArrival, resolveParentKind, type ArrivalContext } from './message-arrival';

describe('resolveParentKind', () => {
  it('trusts the payload parentType over any cache state', () => {
    expect(resolveParentKind('channel', false, true)).toBe('channel');
    expect(resolveParentKind('conversation', true, false)).toBe('conversation');
  });

  it('falls back to the caches for legacy payloads, channel first', () => {
    expect(resolveParentKind(undefined, true, false)).toBe('channel');
    expect(resolveParentKind(undefined, true, true)).toBe('channel');
    expect(resolveParentKind(undefined, false, true)).toBe('conversation');
  });

  it('never guesses when neither the payload nor the caches know the parent', () => {
    expect(resolveParentKind(undefined, false, false)).toBeNull();
    // An unknown future parentType with cold caches must not misfile either.
    expect(resolveParentKind('something-new', false, false)).toBeNull();
  });
});

describe('classifyParentArrival', () => {
  const base: ArrivalContext = {
    isOwnAuthor: false,
    isThreadReply: false,
    isSystem: false,
    viewingParent: false,
    attentive: false,
  };

  // Mirrors CLAUDE.md's user-perspective truth table.
  const rows: Array<[string, Partial<ArrivalContext>, ReturnType<typeof classifyParentArrival>]> = [
    ['own message never touches the badge', { isOwnAuthor: true, viewingParent: true, attentive: true }, 'ignore'],
    ['thread reply belongs to the Threads nav, not the parent badge', { isThreadReply: true }, 'ignore'],
    ['system events (join/leave) are not new activity', { isSystem: true }, 'ignore'],
    ['watching it happen → read', { viewingParent: true, attentive: true }, 'mark-read'],
    ['route open but NOT looking (ghost-DM bug) → badge stays', { viewingParent: true, attentive: false }, 'bump-unread'],
    ['attentive but on a different parent → badge', { viewingParent: false, attentive: true }, 'bump-unread'],
    ['neither viewing nor attentive → badge', {}, 'bump-unread'],
  ];

  it.each(rows)('%s', (_name, overrides, expected) => {
    expect(classifyParentArrival({ ...base, ...overrides })).toBe(expected);
  });
});
