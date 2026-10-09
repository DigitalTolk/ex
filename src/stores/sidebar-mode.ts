import { create } from 'zustand';
import type { ActivityTab } from '@/lib/activity-feed';

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

export const useSidebarModeStore = create<SidebarModeState>(() => ({ ...initial }));

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
// start on the previous one's list, filter or selection.
export function resetSidebarModeSessionState(): void {
  useSidebarModeStore.setState({ ...initial });
}
