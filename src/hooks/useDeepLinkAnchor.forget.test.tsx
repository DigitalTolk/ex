import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { forgetDeepLinkInAddress, useListAnchor } from './useDeepLinkAnchor';

describe('forgetDeepLinkInAddress', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('drops the thread and message parts of the address and keeps the history state', () => {
    window.history.replaceState({ usr: null, key: 'abc', idx: 3 }, '', '/channel/general?thread=root#msg-reply');
    forgetDeepLinkInAddress();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/channel/general');
    expect(window.history.state).toEqual({ usr: null, key: 'abc', idx: 3 });
  });

  it('leaves a clean address untouched', () => {
    window.history.replaceState({ key: 'k' }, '', '/channel/general');
    forgetDeepLinkInAddress();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/channel/general');
    expect(window.history.state).toEqual({ key: 'k' });
  });

  it('jumping to the latest messages forgets the link too', () => {
    window.history.replaceState(null, '', '/channel/general#msg-m1');
    const { result } = renderHook(() => useListAnchor('m1', 'nav-1'));
    expect(result.current.listAnchor).toBe('m1');
    act(() => result.current.showLatest());
    expect(result.current.listAnchor).toBeUndefined();
    expect(window.location.hash).toBe('');
  });
});
