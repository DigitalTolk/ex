import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addInViewThread,
  isThreadInView,
  removeInViewThread,
  resetThreadScopeForTests,
  setPanelThread,
  setThreadScopeBroadcast,
  threadScopeSnapshot,
} from './thread-scope';

describe('thread-scope', () => {
  beforeEach(() => {
    resetThreadScopeForTests();
  });

  it('tracks the open panel thread', () => {
    expect(isThreadInView('root-1')).toBe(false);
    setPanelThread('root-1');
    expect(isThreadInView('root-1')).toBe(true);
    setPanelThread(null);
    expect(isThreadInView('root-1')).toBe(false);
  });

  it('tracks /threads cards in the viewport', () => {
    addInViewThread('root-a');
    addInViewThread('root-b');
    expect(isThreadInView('root-a')).toBe(true);
    expect(isThreadInView('root-b')).toBe(true);
    removeInViewThread('root-a');
    expect(isThreadInView('root-a')).toBe(false);
    expect(isThreadInView('root-b')).toBe(true);
  });

  it('broadcasts only on real scope changes (dedups no-op registrations)', () => {
    const broadcast = vi.fn();
    setThreadScopeBroadcast(broadcast);
    setPanelThread('root-1');
    setPanelThread('root-1'); // no change
    addInViewThread('root-a');
    addInViewThread('root-a'); // no change
    removeInViewThread('root-a');
    removeInViewThread('root-a'); // no change
    setPanelThread(null);
    expect(broadcast).toHaveBeenCalledTimes(4);
  });

  it('snapshot lists the panel thread first, dedups it against in-view cards, and caps the list', () => {
    setPanelThread('root-panel');
    addInViewThread('root-panel'); // also in view — must not repeat
    for (let i = 0; i < 40; i++) addInViewThread(`root-${i}`);
    const snap = threadScopeSnapshot();
    expect(snap[0]).toBe('root-panel');
    expect(snap.filter((id) => id === 'root-panel')).toHaveLength(1);
    expect(snap.length).toBeLessThanOrEqual(30);
  });

  it('snapshot without a panel thread is just the in-view set', () => {
    addInViewThread('root-a');
    expect(threadScopeSnapshot()).toEqual(['root-a']);
  });
});
