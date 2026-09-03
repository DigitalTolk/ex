import { beforeEach, describe, expect, it } from 'vitest';

import {
  onRunProgress,
  onRunUpdated,
  resetAgentRunsSessionState,
  useAgentRunsStore,
} from './agent-runs';

function runsFor(parentID: string) {
  return useAgentRunsStore.getState().runsByParent[parentID] ?? [];
}

describe('agent-runs store', () => {
  beforeEach(() => {
    resetAgentRunsSessionState();
  });

  it('adds active runs and removes terminal ones', () => {
    onRunUpdated({ id: 'r1', agentID: 'a-gg', parentID: 'chan1', state: 'acknowledged' });
    expect(runsFor('chan1')).toHaveLength(1);
    expect(runsFor('chan1')[0].action).toBe('starting up…');

    onRunUpdated({ id: 'r1', agentID: 'a-gg', parentID: 'chan1', state: 'completed' });
    expect(runsFor('chan1')).toHaveLength(0);
  });

  it('progress beats narrate tool activity and keep lifecycle state', () => {
    onRunUpdated({ id: 'r1', agentID: 'a-gg', parentID: 'chan1', state: 'running' });
    onRunProgress({ runID: 'r1', agentID: 'a-gg', parentID: 'chan1', kind: 'tool', tool: 'post_message' });
    expect(runsFor('chan1')[0].action).toBe('posting a reply…');
    expect(runsFor('chan1')[0].state).toBe('running');

    onRunProgress({ runID: 'r1', agentID: 'a-gg', parentID: 'chan1', kind: 'text', text: '  The channel is about\nonboarding ' });
    expect(runsFor('chan1')[0].action).toContain('The channel is about onboarding');
  });

  it('tracks multiple concurrent runs per parent, isolated by parent', () => {
    onRunUpdated({ id: 'r1', agentID: 'a-gg', parentID: 'chan1', state: 'running' });
    onRunUpdated({ id: 'r2', agentID: 'a-qib', parentID: 'chan1', state: 'running' });
    onRunUpdated({ id: 'r3', agentID: 'a-gg', parentID: 'chan2', state: 'running' });
    expect(runsFor('chan1')).toHaveLength(2);
    expect(runsFor('chan2')).toHaveLength(1);
  });

  it('a progress beat for an unknown run still surfaces it (missed run.updated)', () => {
    onRunProgress({ runID: 'r9', agentID: 'a-gg', parentID: 'chan1', kind: 'tool', tool: 'get_thread' });
    expect(runsFor('chan1')).toHaveLength(1);
    expect(runsFor('chan1')[0].action).toBe('reading the thread…');
  });

  it('ignores malformed frames', () => {
    onRunUpdated(null);
    onRunUpdated({ id: 'r1' });
    onRunProgress({ runID: 'r1' });
    expect(runsFor('chan1')).toHaveLength(0);
  });
});
