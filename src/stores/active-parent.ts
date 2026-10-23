import { create } from 'zustand';

// The channel or conversation this tab has open — the ONE record of it. The
// open view registers it (useParentChat); everything that asks "is the user
// on this parent?" reads it here:
//   - unread: a message.new for the open parent can be read on arrival
//     (UnreadContext.isActiveChannel / isActiveConversation);
//   - notification suppression: an alert for the parent the user is looking
//     at surfaces nothing (NotificationContext);
//   - the tab election: siblings learn which parent this tab is viewing
//     (lib/tab-leader broadcasts it).
// Being open is not being read — every consumer still gates on attention
// (CLAUDE.md's truth table); this only says which parent is on screen.

export type ParentKind = 'channel' | 'conversation';

export interface ActiveParent {
  kind: ParentKind;
  id: string;
}

interface ActiveParentState {
  parent: ActiveParent | null;
}

export const useActiveParentStore = create<ActiveParentState>(() => ({ parent: null }));

export function setActiveParent(parent: ActiveParent | null): void {
  useActiveParentStore.setState({ parent });
}

// clearActiveParent closes `parent` — unless another view has registered its
// own parent since (navigating between two chats can unmount the old view
// after the new one registered).
export function clearActiveParent(parent: ActiveParent): void {
  const current = useActiveParentStore.getState().parent;
  if (current?.kind === parent.kind && current.id === parent.id) setActiveParent(null);
}

export function activeParentID(): string | null {
  return useActiveParentStore.getState().parent?.id ?? null;
}

export function isActiveParent(kind: ParentKind, id: string): boolean {
  const current = useActiveParentStore.getState().parent;
  return current?.kind === kind && current.id === id;
}
