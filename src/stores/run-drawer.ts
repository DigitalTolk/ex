import { create } from 'zustand';

// Which run's Activity Drawer is open, app-wide. The drawer renders once at
// the chat root; anything that knows a runID (the activity chip, the
// popover rows) opens it from here.
interface RunDrawerState {
  runID: string | null;
}

export const useRunDrawerStore = create<RunDrawerState>(() => ({ runID: null }));

export function openRunDrawer(runID: string): void {
  useRunDrawerStore.setState({ runID });
}

export function closeRunDrawer(): void {
  useRunDrawerStore.setState({ runID: null });
}
