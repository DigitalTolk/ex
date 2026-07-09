import { describe, expect, it } from 'vitest';
import { shouldAutoStickMessageList } from './message-list-autostick';

// Pure-logic coverage for every arm of the auto-stick predicate. Both
// short-circuit operands of `anchorMsgId || hasPreviousPage` (line 7)
// need independent truthy/falsy inputs to be exercised.

describe('shouldAutoStickMessageList', () => {
  it('never sticks when a deep-link anchor is set', () => {
    expect(shouldAutoStickMessageList({ anchorMsgId: 'm-1', atBottom: true })).toBe(false);
  });

  it('never sticks when there are newer pages to load (hasPreviousPage)', () => {
    // anchorMsgId falsy → the right operand `hasPreviousPage` is evaluated.
    expect(
      shouldAutoStickMessageList({ anchorMsgId: undefined, hasPreviousPage: true, atBottom: true }),
    ).toBe(false);
  });

  it('does not stick when auto-stick is suppressed (user scrolled up)', () => {
    expect(
      shouldAutoStickMessageList({ atBottom: true, autoStickSuppressed: true }),
    ).toBe(false);
  });

  it('sticks when at the live tail, at bottom, not suppressed, no anchor', () => {
    expect(
      shouldAutoStickMessageList({
        anchorMsgId: undefined,
        hasPreviousPage: false,
        atBottom: true,
        autoStickSuppressed: false,
      }),
    ).toBe(true);
  });

  it('does not stick when the user is not at the bottom', () => {
    expect(shouldAutoStickMessageList({ atBottom: false })).toBe(false);
  });
});
