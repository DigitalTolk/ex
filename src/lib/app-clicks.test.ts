import { describe, expect, it } from 'vitest';
import { clickOrigin, isOwnClick, newClickID } from './app-clicks';

describe('app clicks', () => {
  it('names each click from this tab with a fresh random ID it then recognizes', () => {
    const a = newClickID();
    const b = newClickID();
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(b).not.toBe(a);
    expect(isOwnClick(a)).toBe(true);
    expect(isOwnClick(b)).toBe(true);
  });

  it("doesn't claim a click it never sent, or none at all", () => {
    expect(isOwnClick('0123456789abcdef01234567')).toBe(false);
    expect(isOwnClick('')).toBe(false);
    expect(isOwnClick(undefined)).toBe(false);
  });

  it('remembers the last 200 clicks and forgets the oldest past that', () => {
    const first = newClickID();
    const later = Array.from({ length: 199 }, () => newClickID());
    expect(isOwnClick(first)).toBe(true);
    newClickID();
    expect(isOwnClick(first)).toBe(false);
    expect(later.every(isOwnClick)).toBe(true);
  });

  it('remembers the card a click came from, while it remembers the click', () => {
    const fromCard = newClickID({ messageID: 'm1' });
    const fromNowhere = newClickID();
    expect(clickOrigin(fromCard)).toEqual({ messageID: 'm1' });
    expect(clickOrigin(fromNowhere)).toBeUndefined();
    expect(clickOrigin(undefined)).toBeUndefined();
    expect(clickOrigin('')).toBeUndefined();
    // Past the cap the card goes with the click.
    Array.from({ length: 200 }, () => newClickID({ messageID: 'm2' }));
    expect(isOwnClick(fromCard)).toBe(false);
    expect(clickOrigin(fromCard)).toBeUndefined();
  });
});
