import { describe, expect, it } from 'vitest';
import {
  clearTyping,
  recordTyping,
  setSelfUserID,
  stopTypingExpiryTimer,
  threadTypingKey,
  useTypingStore,
} from './typing';

// Unit coverage for the typing store's pure arms — the interval/expiry
// behaviour is exercised end-to-end by the TypingContext suites; the
// global afterEach in the test setup resets the store between tests.

describe('typing store', () => {
  it('ignores records/clears with a missing parentID or userID', () => {
    recordTyping('', 'u-1');
    recordTyping('ch-1', '');
    clearTyping('', 'u-1');
    clearTyping('ch-1', '');
    expect(useTypingStore.getState().typingByParent).toEqual({});
  });

  it('groups main-list and thread typing into separate buckets', () => {
    recordTyping('ch-1', 'u-1');
    recordTyping('ch-1', 'u-2', 'root-1');
    const s = useTypingStore.getState();
    expect(s.typingByParent['ch-1']).toEqual(['u-1']);
    expect(s.typingByThread[threadTypingKey('ch-1', 'root-1')]).toEqual(['u-2']);
  });

  it('refreshes an existing entry instead of double-counting', () => {
    recordTyping('ch-1', 'u-1');
    recordTyping('ch-1', 'u-1');
    expect(useTypingStore.getState().typingByParent['ch-1']).toEqual(['u-1']);
  });

  it('clearTyping drops a present entry and ignores a missing one', () => {
    recordTyping('ch-1', 'u-1');
    clearTyping('ch-1', 'u-missing');
    expect(useTypingStore.getState().typingByParent['ch-1']).toEqual(['u-1']);
    clearTyping('ch-1', 'u-1');
    expect(useTypingStore.getState().typingByParent['ch-1']).toBeUndefined();
  });

  it('excludes the self user from every bucket', () => {
    setSelfUserID('u-self');
    recordTyping('ch-1', 'u-self');
    recordTyping('ch-1', 'u-other');
    expect(useTypingStore.getState().typingByParent['ch-1']).toEqual(['u-other']);
  });

  it('keeps map identity stable across no-op rebuilds', () => {
    recordTyping('ch-1', 'u-1');
    const before = useTypingStore.getState().typingByParent;
    setSelfUserID(null); // triggers a rebuild that changes nothing
    expect(useTypingStore.getState().typingByParent).toEqual(before);
  });

  it('stopTypingExpiryTimer is safe with and without a live timer', () => {
    stopTypingExpiryTimer(); // no timer armed
    recordTyping('ch-1', 'u-1'); // arms the timer
    stopTypingExpiryTimer();
    expect(useTypingStore.getState().typingByParent['ch-1']).toEqual(['u-1']);
  });
});
