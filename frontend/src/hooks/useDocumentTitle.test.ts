import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDocumentTitle } from './useDocumentTitle';
import { setDocumentNotificationCount } from '@/lib/document-title';

// Real-hook lifecycle coverage. useDocumentTitle wires document.title to a page
// name AND the external notification-count store (useSyncExternalStore). These
// tests drive the full mount → live-count → unmount sequence to prove the store
// subscription is set up and torn down correctly.

describe('useDocumentTitle', () => {
  afterEach(() => {
    act(() => setDocumentNotificationCount(0));
    document.title = '';
  });

  it('reflects the page, folds in live notification-count changes, and stops after unmount', () => {
    const { rerender, unmount } = renderHook(({ page }) => useDocumentTitle(page), {
      initialProps: { page: 'Threads' as string | null },
    });

    // Step 1: mount with count 0 → bare "<page> · ex".
    expect(document.title).toBe('Threads · ex');

    // Step 2: an external notification count arrives → the (n) prefix appears.
    act(() => setDocumentNotificationCount(3));
    expect(document.title).toBe('(3) Threads · ex');

    // Step 3: the page changes while a count is live → both compose.
    rerender({ page: 'General' });
    expect(document.title).toBe('(3) General · ex');

    // Step 4: the count clears → the prefix drops again.
    act(() => setDocumentNotificationCount(0));
    expect(document.title).toBe('General · ex');

    // Step 5: a fresh count re-applies the prefix (still mounted, still live).
    act(() => setDocumentNotificationCount(2));
    expect(document.title).toBe('(2) General · ex');

    // Step 6: unmount → the store subscription must be torn down. A later count
    // change must NOT mutate the title (a leaked subscriber was the regression).
    unmount();
    document.title = 'sentinel';
    act(() => setDocumentNotificationCount(7));
    expect(document.title).toBe('sentinel');
  });

  it('uses the bare app name when the page is null', () => {
    renderHook(() => useDocumentTitle(null));
    expect(document.title).toBe('ex');
  });
});
