import { beforeEach, describe, expect, it } from 'vitest';

import { closeRunDrawer, openRunDrawer, openThreadDrawer, useRunDrawerStore } from '@/stores/run-drawer';

// Unit coverage for the run-drawer store — a tiny app-wide singleton that
// tracks which activity the Drawer shows (one run, or a whole thread).

describe('run-drawer store', () => {
  beforeEach(() => {
    closeRunDrawer();
  });

  it('starts closed', () => {
    expect(useRunDrawerStore.getState()).toEqual({ runID: null, thread: null });
  });

  it('openRunDrawer targets one run and clears any thread target', () => {
    openThreadDrawer('chan1', 'root1');
    openRunDrawer('run-1');
    expect(useRunDrawerStore.getState()).toEqual({ runID: 'run-1', thread: null });
  });

  it('openThreadDrawer targets a whole thread and clears any run target', () => {
    openRunDrawer('run-1');
    openThreadDrawer('chan1', 'root1');
    expect(useRunDrawerStore.getState()).toEqual({
      runID: null,
      thread: { parentID: 'chan1', rootID: 'root1' },
    });
  });

  it('closeRunDrawer clears both targets', () => {
    openRunDrawer('run-1');
    closeRunDrawer();
    expect(useRunDrawerStore.getState()).toEqual({ runID: null, thread: null });

    openThreadDrawer('chan1', 'root1');
    closeRunDrawer();
    expect(useRunDrawerStore.getState()).toEqual({ runID: null, thread: null });
  });
});
