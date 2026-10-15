import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ActivityTab } from '@/lib/activity-feed';
import { readString, removeKey, writeString } from '@/lib/storage';

// What the left sidebar shows: the usual channel list ("home") or the
// Activity list. Switching never navigates — opening an activity item does,
// and the sidebar stays on Activity while you read it in context.
export type SidebarMode = 'home' | 'activity';

interface SidebarModeState {
  mode: SidebarMode;
  filter: ActivityTab;
  unreadOnly: boolean;
  // The row last opened from the list; highlighted (and kept in an "Unread
  // only" list) while its message is the page on screen.
  selectedKey: string | null;
}

const initial: SidebarModeState = { mode: 'home', filter: 'all', unreadOnly: false, selectedKey: null };

// "Unread only" is this device's preference, like the channel list's unread
// view: kept in localStorage, across sessions and sign-outs. Which list, tab
// and row are on screen is the session's.
export const SIDEBAR_MODE_STORAGE_KEY = 'sidebar.activity';

export const useSidebarModeStore = create<SidebarModeState>()(
  persist(() => ({ ...initial }), {
    name: SIDEBAR_MODE_STORAGE_KEY,
    storage: createJSONStorage(() => ({ getItem: readString, setItem: writeString, removeItem: removeKey })),
    partialize: ({ unreadOnly }) => ({ unreadOnly }),
  }),
);

export function setSidebarMode(mode: SidebarMode): void {
  useSidebarModeStore.setState({ mode });
}

export function setActivityFilter(filter: ActivityTab): void {
  useSidebarModeStore.setState({ filter });
}

export function setActivityUnreadOnly(unreadOnly: boolean): void {
  useSidebarModeStore.setState({ unreadOnly });
}

export function selectActivityRow(selectedKey: string | null): void {
  useSidebarModeStore.setState({ selectedKey });
}

// Back to the defaults — on logout, so the next user in this tab doesn't
// start on the previous one's list, filter or selection. The device keeps its
// "Unread only".
export function resetSidebarModeSessionState(): void {
  const { mode, filter, selectedKey } = initial;
  useSidebarModeStore.setState({ mode, filter, selectedKey });
}
