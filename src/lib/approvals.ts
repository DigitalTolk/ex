import { ApiError, apiFetch } from '@/lib/api';
import { settleApprovalLocally } from '@/stores/agent-approvals';

// The single place a human approval decision is sent.
//
// It exists because the same fetch-then-settle block was written three times
// (the card's Approve/Deny, the card's "always allow" loop, and the desktop
// notification bridge) and all three settled the card in a `finally` — so a
// network blip dismissed the card while the server still held the gate
// pending, and the agent read the user's Approve as a timeout-denial minutes
// later. The decision is only recorded locally once the server has it.

// A 4xx that means "this gate is already resolved" — the card is genuinely
// gone, so dismissing it is correct. 409 is the server's "already settled";
// 404 means the approval (or its run) no longer exists.
function alreadyResolved(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 409);
}

export interface ApprovalDecision {
  approvalID: string;
  runID: string;
  approve: boolean;
  choice?: string;
  /** The invoker's note to the agent, or the edited text of a reply proposal. */
  text?: string;
}

// decideApproval POSTs one verdict and dismisses the card only when the
// decision actually landed. Returns false when it did not — the caller keeps
// the card up so the person can try again.
export async function decideApproval(d: ApprovalDecision): Promise<boolean> {
  try {
    await apiFetch(`/api/v1/runs/${d.runID}/approvals/${d.approvalID}`, {
      method: 'POST',
      body: JSON.stringify({ approve: d.approve, choice: d.choice, text: d.text }),
    });
  } catch (err) {
    if (!alreadyResolved(err)) return false;
  }
  settleApprovalLocally(d.approvalID);
  return true;
}
