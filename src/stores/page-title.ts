import { useEffect } from 'react';
import { create } from 'zustand';

// The title of the page on screen, for the phone's top bar: there the back
// button and the page's name share one row instead of the name taking a row
// of its own below. Pages announce it with usePageTitle; the top bar reads it.
export const usePageTitleStore = create<{ title: string | null }>(() => ({ title: null }));

export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    if (!title) return;
    usePageTitleStore.setState({ title });
    return () => {
      // Only clear our own title — the next page may already have set its.
      if (usePageTitleStore.getState().title === title) usePageTitleStore.setState({ title: null });
    };
  }, [title]);
}
