import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch,
}));

import {
  loadPendingApprovals,
  onRunApproval,
  resetAgentApprovalsSessionState,
  useAgentApprovalsStore,
} from '@/stores/agent-approvals';

const ids = (parentID: string) =>
  (useAgentApprovalsStore.getState().approvalsByParent[parentID] ?? []).map((a) => a.approvalID);

const frame = (approvalID: string, extra: Record<string, unknown> = {}) => ({
  approvalID,
  runID: 'r1',
  parentID: 'chan1',
  state: 'pending',
  summary: `run ${approvalID}`,
  ...extra,
});

// Each card arrives once, as an event; a page that loads or reconnects asks
// the server what is still waiting.
describe('loadPendingApprovals', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    resetAgentApprovalsSessionState();
  });
  afterEach(() => resetAgentApprovalsSessionState());

  it('shows the cards still waiting, skipping anything it cannot read', async () => {
    apiFetch.mockResolvedValue({ approvals: [frame('ap1'), { approvalID: 'bad' }, frame('ap2', { state: 'approved' })] });
    await loadPendingApprovals();
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/approvals/pending');
    expect(ids('chan1')).toEqual(['ap1']);
    expect(useAgentApprovalsStore.getState().approvalsByParent.chan1[0].summary).toBe('run ap1');
  });

  it('drops a card whose decision it missed, and keeps one that arrived while asking', async () => {
    onRunApproval(frame('settled-elsewhere'));
    vi.useFakeTimers({ now: Date.now() + 1000 });
    let answer!: (v: unknown) => void;
    apiFetch.mockReturnValue(new Promise((r) => (answer = r)));
    const loading = loadPendingApprovals();
    vi.setSystemTime(Date.now() + 1000);
    onRunApproval(frame('just-asked'));
    answer({ approvals: [frame('still-open')] });
    await loading;
    vi.useRealTimers();
    expect(ids('chan1')).toEqual(['just-asked', 'still-open']);
  });

  it('keeps what is there when the list cannot be loaded, or comes back empty', async () => {
    onRunApproval(frame('ap1'));
    apiFetch.mockRejectedValue(new Error('offline'));
    await loadPendingApprovals();
    expect(ids('chan1')).toEqual(['ap1']);

    // An empty answer drops a card that was already there before asking.
    vi.useFakeTimers({ now: Date.now() + 1000 });
    apiFetch.mockResolvedValue(undefined);
    await loadPendingApprovals();
    vi.useRealTimers();
    expect(ids('chan1')).toEqual([]);
  });
});
