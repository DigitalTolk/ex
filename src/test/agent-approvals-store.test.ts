import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  onRunApproval,
  resetAgentApprovalsSessionState,
  settleApprovalLocally,
  useAgentApprovalsFor,
  useAgentApprovalsStore,
} from '@/stores/agent-approvals';

function approvalsFor(parentID: string) {
  return useAgentApprovalsStore.getState().approvalsByParent[parentID] ?? [];
}

// A minimal valid pending frame; tests spread extra fields over it.
function pendingFrame(extra: Record<string, unknown> = {}) {
  return { approvalID: 'ap1', runID: 'r1', parentID: 'chan1', state: 'pending', ...extra };
}

describe('agent-approvals store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAgentApprovalsSessionState();
  });

  afterEach(() => {
    resetAgentApprovalsSessionState();
    vi.useRealTimers();
  });

  it('ignores malformed frames without publishing', () => {
    const before = useAgentApprovalsStore.getState().approvalsByParent;
    onRunApproval(null);
    onRunApproval({});
    onRunApproval({ approvalID: 'ap1' }); // no parentID
    onRunApproval({ approvalID: 'ap1', parentID: 'chan1' }); // no runID
    onRunApproval({ runID: 'r1', parentID: 'chan1', state: 'pending' }); // no approvalID
    expect(useAgentApprovalsStore.getState().approvalsByParent).toBe(before);
  });

  it('a pending request appears with defaults filled in', () => {
    onRunApproval(pendingFrame());
    const [card] = approvalsFor('chan1');
    expect(card).toMatchObject({
      approvalID: 'ap1',
      runID: 'r1',
      parentID: 'chan1',
      agentID: '',
      invokerID: '',
      parentType: 'channel',
      summary: '',
    });
    expect(card.kind).toBeUndefined();
    expect(card.options).toBeUndefined();
    expect(card.replyText).toBeUndefined();
  });

  it('a fully populated request keeps every field', () => {
    onRunApproval(
      pendingFrame({
        agentID: 'a-gg',
        invokerID: 'u-1',
        parentType: 'conversation',
        messageID: 'm-1',
        summary: 'Run rm -rf?',
        risk: 'high',
        kind: 'shell',
        options: ['allow', 'always allow shell'],
        replyText: 'Here is my draft',
        replyToMessageID: 'm-0',
        deadline: '2099-01-01T00:00:00Z',
      }),
    );
    expect(approvalsFor('chan1')[0]).toMatchObject({
      agentID: 'a-gg',
      invokerID: 'u-1',
      parentType: 'conversation',
      messageID: 'm-1',
      summary: 'Run rm -rf?',
      risk: 'high',
      kind: 'shell',
      options: ['allow', 'always allow shell'],
      replyText: 'Here is my draft',
      replyToMessageID: 'm-0',
      deadline: '2099-01-01T00:00:00Z',
    });
  });

  it('empty-string kind and replyText normalize to undefined', () => {
    onRunApproval(pendingFrame({ kind: '', replyText: '' }));
    const [card] = approvalsFor('chan1');
    expect(card.kind).toBeUndefined();
    expect(card.replyText).toBeUndefined();
  });

  it('sorts a parent’s requests by approvalID and isolates parents', () => {
    onRunApproval(pendingFrame({ approvalID: 'ap-b' }));
    onRunApproval(pendingFrame({ approvalID: 'ap-a' }));
    onRunApproval(pendingFrame({ approvalID: 'ap-c', parentID: 'chan2' }));
    expect(approvalsFor('chan1').map((a) => a.approvalID)).toEqual(['ap-a', 'ap-b']);
    expect(approvalsFor('chan2').map((a) => a.approvalID)).toEqual(['ap-c']);
  });

  it('a re-sent request replaces the existing card instead of duplicating', () => {
    onRunApproval(pendingFrame({ summary: 'v1' }));
    onRunApproval(pendingFrame({ summary: 'v2' }));
    const cards = approvalsFor('chan1');
    expect(cards).toHaveLength(1);
    expect(cards[0].summary).toBe('v2');
  });

  it('any settle state removes the card; a settle for an unknown id is a no-op', () => {
    onRunApproval(pendingFrame());
    onRunApproval(pendingFrame({ approvalID: 'ap2', state: 'denied' })); // unknown id: nothing to delete
    const before = useAgentApprovalsStore.getState().approvalsByParent;
    onRunApproval({ approvalID: 'ap-ghost', runID: 'r1', parentID: 'chan1', state: 'expired' });
    expect(useAgentApprovalsStore.getState().approvalsByParent).toBe(before);

    onRunApproval(pendingFrame({ state: 'approved' }));
    expect(approvalsFor('chan1')).toHaveLength(0);
  });

  it('settleApprovalLocally removes the card immediately; unknown ids are a no-op', () => {
    onRunApproval(pendingFrame());
    const before = useAgentApprovalsStore.getState().approvalsByParent;
    settleApprovalLocally('ap-ghost');
    expect(useAgentApprovalsStore.getState().approvalsByParent).toBe(before);

    settleApprovalLocally('ap1');
    expect(approvalsFor('chan1')).toHaveLength(0);
  });

  it('arms one sweep timer while requests exist and clears it when the last settles', () => {
    expect(vi.getTimerCount()).toBe(0);
    onRunApproval(pendingFrame());
    expect(vi.getTimerCount()).toBe(1);
    onRunApproval(pendingFrame({ approvalID: 'ap2' })); // timer already armed
    expect(vi.getTimerCount()).toBe(1);
    settleApprovalLocally('ap1');
    expect(vi.getTimerCount()).toBe(1); // ap2 still pending
    settleApprovalLocally('ap2');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the sweep drops a card with no fresh beat past the stale window', () => {
    onRunApproval(pendingFrame()); // no deadline
    vi.advanceTimersByTime(30_000); // one sweep: still fresh
    expect(approvalsFor('chan1')).toHaveLength(1);
    vi.advanceTimersByTime(10 * 60_000 + 30_000); // well past STALE_MS
    expect(approvalsFor('chan1')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0); // publish disarmed the empty sweep
  });

  it('the sweep drops a card 30s past its deadline even while otherwise fresh', () => {
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const farDeadline = new Date(Date.now() + 60 * 60_000).toISOString();
    onRunApproval(pendingFrame({ deadline }));
    onRunApproval(pendingFrame({ approvalID: 'ap2', deadline: farDeadline }));
    onRunApproval(pendingFrame({ approvalID: 'ap3', deadline: 'not-a-date' }));
    vi.advanceTimersByTime(30_000); // deadline not yet 30s past: everything stays
    expect(approvalsFor('chan1')).toHaveLength(3);
    vi.advanceTimersByTime(90_000); // now > deadline + 30s, but nothing is stale
    expect(approvalsFor('chan1').map((a) => a.approvalID)).toEqual(['ap2', 'ap3']);
  });

  it('useAgentApprovalsFor tracks one parent and hands back a stable empty list', () => {
    const { result } = renderHook(() => useAgentApprovalsFor('chan1'));
    expect(result.current).toEqual([]);
    const { result: other } = renderHook(() => useAgentApprovalsFor('chan-none'));
    expect(other.current).toBe(result.current); // shared EMPTY identity

    act(() => {
      onRunApproval(pendingFrame());
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0].approvalID).toBe('ap1');
    expect(other.current).toEqual([]);

    act(() => {
      settleApprovalLocally('ap1');
    });
    expect(result.current).toEqual([]);
  });

  it('resetAgentApprovalsSessionState clears every parent', () => {
    onRunApproval(pendingFrame());
    onRunApproval(pendingFrame({ approvalID: 'ap2', parentID: 'chan2' }));
    resetAgentApprovalsSessionState();
    expect(useAgentApprovalsStore.getState().approvalsByParent).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });
});
