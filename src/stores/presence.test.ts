import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useIsOnline, usePresenceStore } from './presence';

// Unit coverage for the presence store — the global afterEach in the test
// setup resets it between tests.

describe('presence store', () => {
  it('setUserOnline adds and removes users', () => {
    usePresenceStore.getState().setUserOnline('u-1', true);
    expect(usePresenceStore.getState().online.has('u-1')).toBe(true);
    usePresenceStore.getState().setUserOnline('u-1', false);
    expect(usePresenceStore.getState().online.has('u-1')).toBe(false);
  });

  it('setUserOnline bails out identity-stable on no-op transitions', () => {
    usePresenceStore.getState().setUserOnline('u-1', true);
    const before = usePresenceStore.getState().online;
    usePresenceStore.getState().setUserOnline('u-1', true); // already online
    expect(usePresenceStore.getState().online).toBe(before);
    usePresenceStore.getState().setUserOnline('u-ghost', false); // already offline
    expect(usePresenceStore.getState().online).toBe(before);
  });

  it('replaceOnline swaps the whole set', () => {
    usePresenceStore.getState().setUserOnline('u-old', true);
    usePresenceStore.getState().replaceOnline(['u-a', 'u-b']);
    const online = usePresenceStore.getState().online;
    expect(online.has('u-old')).toBe(false);
    expect(online.has('u-a')).toBe(true);
    expect(online.has('u-b')).toBe(true);
  });

  it('useIsOnline tracks a single user and treats undefined as offline', () => {
    usePresenceStore.getState().setUserOnline('u-1', true);
    const { result: yes } = renderHook(() => useIsOnline('u-1'));
    expect(yes.current).toBe(true);
    const { result: no } = renderHook(() => useIsOnline('u-2'));
    expect(no.current).toBe(false);
    const { result: none } = renderHook(() => useIsOnline(undefined));
    expect(none.current).toBe(false);
  });
});
