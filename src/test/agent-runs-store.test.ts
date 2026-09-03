import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  onRunProgress,
  onRunUpdated,
  resetAgentRunsSessionState,
  useAgentRunsFor,
  useAgentRunsStore,
} from '@/stores/agent-runs';

// Complements src/stores/agent-runs.test.ts with the timer-driven arms
// (stale sweep, tombstone pruning) and the remaining label/merge branches.

function runsFor(parentID: string) {
  return useAgentRunsStore.getState().runsByParent[parentID] ?? [];
}

function progress(extra: Record<string, unknown> = {}) {
  return { runID: 'r1', agentID: 'a-gg', parentID: 'chan1', ...extra };
}

describe('agent-runs store (timers, labels, tombstones)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAgentRunsSessionState();
  });

  afterEach(() => {
    resetAgentRunsSessionState();
    vi.useRealTimers();
  });

  it('ignores malformed frames without publishing', () => {
    const before = useAgentRunsStore.getState().runsByParent;
    onRunUpdated(null);
    onRunUpdated({});
    onRunUpdated({ id: 'r1' }); // no parentID
    onRunUpdated({ id: 'r1', parentID: 'chan1' }); // no agentID
    onRunUpdated({ id: 'r1', parentID: 'chan1', agentID: 'a-gg' }); // no state
    onRunProgress(null);
    onRunProgress({});
    onRunProgress({ runID: 'r1' }); // no parentID
    onRunProgress({ runID: 'r1', parentID: 'chan1' }); // no agentID
    expect(useAgentRunsStore.getState().runsByParent).toBe(before);
  });

  it('labels each lifecycle state, falling back to working for unknown ones', () => {
    onRunUpdated({ id: 'r1', agentID: 'a-gg', parentID: 'chan1', state: 'queued' });
    onRunUpdated({ id: 'r2', agentID: 'a-gg', parentID: 'chan1', state: 'acknowledged' });
    onRunUpdated({ id: 'r3', agentID: 'a-gg', parentID: 'chan1', state: 'running' });
    onRunUpdated({ id: 'r4', agentID: 'a-gg', parentID: 'chan1', state: 'paused' });
    expect(runsFor('chan1').map((r) => r.action)).toEqual([
      'queued…',
      'starting up…',
      'working…',
      'working…',
    ]);
  });

  it('a later run.updated keeps the narrated action from the last beat', () => {
    onRunProgress(progress({ kind: 'tool', tool: 'get_thread' }));
    onRunUpdated({ id: 'r1', agentID: 'a-gg', parentID: 'chan1', state: 'running' });
    expect(runsFor('chan1')[0].action).toBe('reading the thread…');
  });

  it('narrates every known tool and generic/unknown fallbacks', () => {
    const cases: Array<[string | undefined, string]> = [
      ['post_message', 'posting a reply…'],
      ['mcp__ex__post_message', 'posting a reply…'],
      ['get_thread', 'reading the thread…'],
      ['mcp__ex__get_thread', 'reading the thread…'],
      ['set_state', 'working…'],
      ['mcp__ex__set_state', 'working…'],
      ['fetch_page', 'using fetch_page…'],
      [undefined, 'working…'], // missing tool name
    ];
    for (const [tool, label] of cases) {
      resetAgentRunsSessionState();
      onRunProgress(progress({ kind: 'tool', tool }));
      expect(runsFor('chan1')[0].action).toBe(label);
    }
  });

  it('narrates text beats: quoted snippet, 90-char cap, thinking fallback', () => {
    onRunProgress(progress({ kind: 'text', text: '  A short\nupdate ' }));
    expect(runsFor('chan1')[0].action).toBe('“A short update”');

    const long = 'x'.repeat(120);
    onRunProgress(progress({ kind: 'text', text: long }));
    expect(runsFor('chan1')[0].action).toBe(`“${'x'.repeat(90)}…”`);

    onRunProgress(progress({ kind: 'text', text: '   ' }));
    expect(runsFor('chan1')[0].action).toBe('thinking…');

    onRunProgress(progress({ kind: 'text' })); // no text at all
    expect(runsFor('chan1')[0].action).toBe('thinking…');
  });

  it('falls back to working for unknown or missing beat kinds', () => {
    onRunProgress(progress({ kind: 'status' }));
    expect(runsFor('chan1')[0].action).toBe('working…');
    onRunProgress(progress({}));
    expect(runsFor('chan1')[0].action).toBe('working…');
  });

  it('a beat carries invoker/thread/state forward from the previous entry', () => {
    onRunUpdated({
      id: 'r1',
      agentID: 'a-gg',
      invokerID: 'u-1',
      parentID: 'chan1',
      threadRootID: 'root-1',
      state: 'acknowledged',
    });
    onRunProgress(progress({ kind: 'tool', tool: 'set_state' })); // beat omits them
    expect(runsFor('chan1')[0]).toMatchObject({
      invokerID: 'u-1',
      threadRootID: 'root-1',
      state: 'acknowledged',
    });

    // A beat's own fields win over the carried ones.
    onRunProgress(progress({ kind: 'tool', tool: 'set_state', invokerID: 'u-2', threadRootID: 'root-2' }));
    expect(runsFor('chan1')[0]).toMatchObject({ invokerID: 'u-2', threadRootID: 'root-2' });
  });

  it('a beat for a never-seen run defaults invoker/thread to unset and state to running', () => {
    onRunProgress(progress({ kind: 'tool', tool: 'set_state' }));
    const [run] = runsFor('chan1');
    expect(run.invokerID).toBeUndefined();
    expect(run.threadRootID).toBeUndefined();
    expect(run.state).toBe('running');
  });

  it('a terminal run.updated for a never-seen run still tombstones it', () => {
    onRunUpdated({ id: 'r-late', agentID: 'a-gg', parentID: 'chan1', state: 'failed' });
    expect(runsFor('chan1')).toHaveLength(0);
    // The tombstone swallows an out-of-order beat instead of resurrecting the run.
    onRunProgress(progress({ runID: 'r-late', kind: 'tool', tool: 'post_message' }));
    expect(runsFor('chan1')).toHaveLength(0);
  });

  it('a beat after a live run terminates does not resurrect it', () => {
    onRunUpdated({ id: 'r1', agentID: 'a-gg', parentID: 'chan1', state: 'running' });
    onRunUpdated({ id: 'r1', agentID: 'a-gg', parentID: 'chan1', state: 'canceled' });
    const before = useAgentRunsStore.getState().runsByParent;
    onRunProgress(progress({ kind: 'text', text: 'still going' }));
    expect(useAgentRunsStore.getState().runsByParent).toBe(before);
    expect(runsFor('chan1')).toHaveLength(0);
  });

  it('the sweep drops a run with no beat past the stale window', () => {
    onRunUpdated({ id: 'r1', agentID: 'a-gg', parentID: 'chan1', state: 'running' });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(15_000); // one sweep: still fresh, nothing changes
    expect(runsFor('chan1')).toHaveLength(1);
    vi.advanceTimersByTime(105_000); // past STALE_MS
    expect(runsFor('chan1')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0); // publish disarmed the timer
  });

  it('the sweep prunes stale tombstones and then disarms itself', () => {
    onRunUpdated({ id: 'r1', agentID: 'a-gg', parentID: 'chan1', state: 'completed' });
    expect(vi.getTimerCount()).toBe(1); // armed purely for the tombstone
    vi.advanceTimersByTime(15_000); // tombstone still fresh
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(105_000); // tombstone pruned; sweep clears its own timer
    expect(vi.getTimerCount()).toBe(0);
    // With the tombstone gone, a (very) late beat may surface the run again.
    onRunProgress(progress({ kind: 'text', text: 'late beat' }));
    expect(runsFor('chan1')).toHaveLength(1);
  });

  it('sorts a parent’s runs by runID and isolates parents', () => {
    onRunUpdated({ id: 'r2', agentID: 'a-gg', parentID: 'chan1', state: 'running' });
    onRunUpdated({ id: 'r1', agentID: 'a-qib', parentID: 'chan1', state: 'running' });
    onRunUpdated({ id: 'r3', agentID: 'a-gg', parentID: 'chan2', state: 'running' });
    expect(runsFor('chan1').map((r) => r.runID)).toEqual(['r1', 'r2']);
    expect(runsFor('chan2').map((r) => r.runID)).toEqual(['r3']);
  });

  it('useAgentRunsFor tracks one parent and hands back a stable empty list', () => {
    const { result } = renderHook(() => useAgentRunsFor('chan1'));
    expect(result.current).toEqual([]);
    const { result: other } = renderHook(() => useAgentRunsFor('chan-none'));
    expect(other.current).toBe(result.current); // shared EMPTY identity

    act(() => {
      onRunUpdated({ id: 'r1', agentID: 'a-gg', parentID: 'chan1', state: 'running' });
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0].runID).toBe('r1');
    expect(other.current).toEqual([]);

    act(() => {
      resetAgentRunsSessionState();
    });
    expect(result.current).toEqual([]);
  });
});
