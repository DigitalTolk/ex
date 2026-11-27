import { describe, it, expect } from 'vitest';
import { visibleCount } from './squads-line';

describe('visibleCount', () => {
  it('shows every squad when they all fit, with no room kept for +N', () => {
    expect(visibleCount([40, 60, 50], 20, 150)).toBe(3);
  });

  it('shows as many as leave room for +N when they do not', () => {
    // 40 + 60 + 20 (the marker) fits in 130; adding 50 would not.
    expect(visibleCount([40, 60, 50], 20, 130)).toBe(2);
  });

  it('always starts the line with one squad, however long', () => {
    expect(visibleCount([300, 40], 20, 100)).toBe(1);
  });
});
