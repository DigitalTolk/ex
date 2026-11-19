import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { readString, removeKey, writeString } from '@/lib/storage';

// How the desktop sidebar (icon rail and channel list) is coloured. 'dark',
// the default, keeps it dark in both themes; 'light' lets it follow the
// theme, so it is light in light mode. In dark mode it is dark either way.
// A device preference, like the theme itself.
export type SidebarTheme = 'dark' | 'light';

export const SIDEBAR_THEME_STORAGE_KEY = 'appearance.sidebar';

export const useSidebarThemeStore = create<{ theme: SidebarTheme }>()(
  persist(() => ({ theme: 'dark' as SidebarTheme }), {
    name: SIDEBAR_THEME_STORAGE_KEY,
    storage: createJSONStorage(() => ({ getItem: readString, setItem: writeString, removeItem: removeKey })),
  }),
);

export function setSidebarTheme(theme: SidebarTheme): void {
  useSidebarThemeStore.setState({ theme });
}

// The class a sidebar surface takes: `.dark` scopes the dark palette to it
// (index.css), '' leaves it to the theme.
export function useSidebarThemeClass(): string {
  return useSidebarThemeStore((s) => (s.theme === 'dark' ? 'dark' : ''));
}
