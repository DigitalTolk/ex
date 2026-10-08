import { create } from 'zustand';
import type { ActivityFilter } from '@/lib/activity-groups';

// What the left sidebar shows: the usual channel list ("home") or the
// Activity list. Switching never navigates — opening an activity item does,
// and the sidebar stays on Activity while you read it in context.
export type SidebarMode = 'home' | 'activity';

interface SidebarModeState {
  mode: SidebarMode;
  filter: ActivityFilter;
  unreadOnly: boolean;
  // The row last opened from the list, highlighted while you're on it.
  selectedKey: string | null;
}

const initial: SidebarModeState = { mode: 'home', filter: 'all', unreadOnly: false, selectedKey: null };

export const useSidebarModeStore = create<SidebarModeState>(() => ({ ...initial }));

export function setSidebarMode(mode: SidebarMode): void {
  useSidebarModeStore.setState({ mode });
}

export function setActivityFilter(filter: ActivityFilter): void {
  useSidebarModeStore.setState({ filter });
}

export function setActivityUnreadOnly(unreadOnly: boolean): void {
  useSidebarModeStore.setState({ unreadOnly });
}

export function selectActivityRow(selectedKey: string | null): void {
  useSidebarModeStore.setState({ selectedKey });
}

// Test seam: module-level state outlives a test's render.
export function resetSidebarModeForTests(): void {
  useSidebarModeStore.setState({ ...initial });
}
