import { describe, it, expect } from 'vitest';
import { deactivatedLast, isDeactivated, withoutDeactivated } from './deactivated';

const active = { id: 'a', status: 'active' };
const gone = { id: 'g', status: 'deactivated' };
const unknown = { id: 'u' };

describe('deactivated accounts', () => {
  it('knows a deactivated account by its status', () => {
    expect(isDeactivated(gone)).toBe(true);
    expect(isDeactivated(active)).toBe(false);
    expect(isDeactivated(unknown)).toBe(false);
  });

  it('leaves them out of what a picker offers', () => {
    expect(withoutDeactivated([gone, active, unknown])).toEqual([active, unknown]);
  });

  it('lists them last, each group in its given order', () => {
    const gone2 = { id: 'g2', status: 'deactivated' };
    expect(deactivatedLast([gone, active, gone2, unknown])).toEqual([active, unknown, gone, gone2]);
  });
});
