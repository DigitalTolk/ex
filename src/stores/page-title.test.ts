import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePageTitle, usePageTitleStore } from './page-title';

afterEach(() => usePageTitleStore.setState({ title: null }));

describe('usePageTitle', () => {
  it('announces the page title while mounted and clears it after', () => {
    const { unmount } = renderHook(() => usePageTitle('Threads'));
    expect(usePageTitleStore.getState().title).toBe('Threads');
    unmount();
    expect(usePageTitleStore.getState().title).toBeNull();
  });

  it('sets nothing without a title', () => {
    usePageTitleStore.setState({ title: 'Other' });
    renderHook(() => usePageTitle(undefined));
    expect(usePageTitleStore.getState().title).toBe('Other');
  });

  it("leaves the next page's title alone when it was set first", () => {
    const { unmount } = renderHook(() => usePageTitle('Threads'));
    // The next page mounts (and announces) before this one unmounts.
    usePageTitleStore.setState({ title: 'Drafts' });
    unmount();
    expect(usePageTitleStore.getState().title).toBe('Drafts');
  });
});
