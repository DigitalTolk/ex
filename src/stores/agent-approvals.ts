import { create } from 'zustand';

// Pending agent-approval requests, per parent — fed by run.approval events.
// A request appears when its state is "pending" and disappears the moment
// any settle (approved/denied/expired) arrives. Mirrors agent-runs' shape:
// module state + a zustand store keyed per parent.

// Belt and braces against a lost settle frame: the backend expires an
// undecided approval within minutes, so a card with no fresher beat past
// this window is stale.
const STALE_MS = 10 * 60_000;

export interface PendingApproval {
  approvalID: string;
  runID: string;
  agentID: string;
  invokerID: string;
  parentID: string;
  parentType?: 'channel' | 'conversation';
  // The message that invoked the run. Only used to ack desktop delivery so the
  // deferred mobile push stands down — never as a dedup key, since every gate
  // in a run shares it.
  messageID?: string;
  summary: string;
  risk?: string;
  // kind is the harness tool class (read | edit | shell | web) for permission
  // gateway approvals — enables "always allow <kind>" on the card.
  kind?: string;
  options?: string[];
  // replyText marks an editable REPLY PROPOSAL (propose_reply): the agent's
  // drafted reply the invoker can edit + send, or cancel. replyToMessageID is
  // the message it answers, shown for context.
  replyText?: string;
  replyToMessageID?: string;
  deadline?: string;
  updatedAt: number;
}

interface AgentApprovalsState {
  approvalsByParent: Record<string, PendingApproval[]>;
}

const entries = new Map<string, PendingApproval>(); // approvalID → request
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export const useAgentApprovalsStore = create<AgentApprovalsState>(() => ({
  approvalsByParent: {},
}));

function publish(): void {
  const next: Record<string, PendingApproval[]> = {};
  for (const e of entries.values()) {
    (next[e.parentID] ??= []).push(e);
  }
  for (const list of Object.values(next)) {
    list.sort((a, b) => a.approvalID.localeCompare(b.approvalID));
  }
  useAgentApprovalsStore.setState({ approvalsByParent: next });
  if (entries.size > 0 && !sweepTimer) {
    sweepTimer = setInterval(sweep, 30_000);
  } else if (entries.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function sweep(): void {
  const cutoff = Date.now() - STALE_MS;
  let changed = false;
  for (const [id, e] of entries) {
    const deadlineMs = e.deadline ? Date.parse(e.deadline) : NaN;
    if (e.updatedAt < cutoff || (Number.isFinite(deadlineMs) && Date.now() > deadlineMs + 30_000)) {
      entries.delete(id);
      changed = true;
    }
  }
  if (changed) publish();
}

// onRunApproval ingests a run.approval frame (request or settle).
export function onRunApproval(data: unknown): void {
  const p = data as {
    approvalID?: string;
    runID?: string;
    agentID?: string;
    invokerID?: string;
    parentID?: string;
    parentType?: string;
    messageID?: string;
    summary?: string;
    risk?: string;
    kind?: string;
    options?: string[];
    replyText?: string;
    replyToMessageID?: string;
    state?: string;
    deadline?: string;
  } | null;
  if (!p?.approvalID || !p.parentID || !p.runID) return;
  if (p.state !== 'pending') {
    if (entries.delete(p.approvalID)) publish();
    return;
  }
  entries.set(p.approvalID, {
    approvalID: p.approvalID,
    runID: p.runID,
    agentID: p.agentID ?? '',
    invokerID: p.invokerID ?? '',
    parentID: p.parentID,
    parentType: p.parentType === 'conversation' ? 'conversation' : 'channel',
    messageID: p.messageID,
    summary: p.summary ?? '',
    risk: p.risk,
    kind: typeof p.kind === 'string' && p.kind ? p.kind : undefined,
    options: Array.isArray(p.options) ? p.options : undefined,
    replyText: typeof p.replyText === 'string' && p.replyText ? p.replyText : undefined,
    replyToMessageID: p.replyToMessageID,
    deadline: p.deadline,
    updatedAt: Date.now(),
  });
  publish();
}

// settleApprovalLocally removes a card immediately after the user's own
// decision — no need to wait for the event round-trip.
export function settleApprovalLocally(approvalID: string): void {
  if (entries.delete(approvalID)) publish();
}

const EMPTY: PendingApproval[] = [];

// useAgentApprovalsFor subscribes to one parent's pending approvals.
export function useAgentApprovalsFor(parentID: string): PendingApproval[] {
  return useAgentApprovalsStore((s) => s.approvalsByParent[parentID] ?? EMPTY);
}

// resetAgentApprovalsSessionState clears everything (logout / tests).
export function resetAgentApprovalsSessionState(): void {
  entries.clear();
  publish();
}
