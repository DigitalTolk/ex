import { create } from 'zustand';

// Which activity the Drawer shows, app-wide. The drawer renders once at the
// chat root; anything that knows a runID (the activity chip, the popover
// rows) opens ONE run from here, and a thread root opens the WHOLE thread —
// every run under it (a coding task is many runs; the card's own run is
// just the intake).
export interface ThreadTarget {
  parentID: string; // channel or conversation id
  rootID: string; // the thread's root message id
}

interface RunDrawerState {
  runID: string | null;
  thread: ThreadTarget | null;
}

export const useRunDrawerStore = create<RunDrawerState>(() => ({ runID: null, thread: null }));

export function openRunDrawer(runID: string): void {
  useRunDrawerStore.setState({ runID, thread: null });
}

export function openThreadDrawer(parentID: string, rootID: string): void {
  useRunDrawerStore.setState({ runID: null, thread: { parentID, rootID } });
}

export function closeRunDrawer(): void {
  useRunDrawerStore.setState({ runID: null, thread: null });
}
