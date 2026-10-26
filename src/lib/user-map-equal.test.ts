import { describe, expect, it } from 'vitest';
import { sameUserMap } from './user-map-equal';

describe('sameUserMap', () => {
  const base = { u1: { displayName: 'Alice', avatarURL: 'a.png', userStatus: { emoji: '🌴', text: 'Away' } } };

  it('treats a rebuilt map with the same entries as the same', () => {
    expect(sameUserMap(base, { u1: { displayName: 'Alice', avatarURL: 'a.png', userStatus: { emoji: '🌴', text: 'Away' } } })).toBe(true);
    expect(sameUserMap({ u1: { displayName: 'A' } }, { u1: { displayName: 'A' } })).toBe(true);
  });

  it('sees any change a row would show', () => {
    expect(sameUserMap(base, {})).toBe(false);
    expect(sameUserMap(base, { u2: base.u1 })).toBe(false);
    expect(sameUserMap(base, { u1: { ...base.u1, displayName: 'Alicia' } })).toBe(false);
    expect(sameUserMap(base, { u1: { ...base.u1, avatarURL: 'b.png' } })).toBe(false);
    expect(sameUserMap(base, { u1: { ...base.u1, userStatus: undefined } })).toBe(false);
    expect(sameUserMap({ u1: { displayName: 'A' } }, { u1: { displayName: 'A', userStatus: { emoji: '🌴', text: '' } } })).toBe(false);
    expect(sameUserMap(base, { u1: { ...base.u1, userStatus: { emoji: '🎉', text: 'Away' } } })).toBe(false);
    expect(sameUserMap(base, { u1: { ...base.u1, userStatus: { emoji: '🌴', text: 'Out' } } })).toBe(false);
    expect(sameUserMap(base, { u1: { ...base.u1, userStatus: { emoji: '🌴', text: 'Away', clearAt: '2026-10-24T00:00:00Z' } } })).toBe(false);
  });
});
