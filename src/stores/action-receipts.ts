import { create } from 'zustand';
import type { SentAnswer } from '@/lib/app-view-form';

// What this person last did on each app card, while the page is open: the
// card itself may be replaced (or answer only with a fleeting toast), so a
// short line under it keeps saying what they did and what the app said —
// and, for a form they sent from it, what they sent.
export interface ActionReceipt {
  text: string;
  notice?: string;
  failed?: boolean;
  details?: { app: string; title: string; notice?: string; answers: SentAnswer[] };
  // The click whose form this line follows, when it follows one.
  clickID?: string;
  at: number;
}

interface ReceiptsState {
  byMessage: Record<string, ActionReceipt>;
}

export const useActionReceipts = create<ReceiptsState>(() => ({ byMessage: {} }));

// noteReceipt sets a card's line. With since, it only does when nothing was
// noted after that moment: a click's late answer never overwrites what the
// click led to (a form opening meanwhile).
export function noteReceipt(messageID: string, receipt: Omit<ActionReceipt, 'at'>, since?: number): void {
  const current = useActionReceipts.getState().byMessage[messageID];
  if (since !== undefined && current && current.at >= since) return;
  useActionReceipts.setState((s) => ({ byMessage: { ...s.byMessage, [messageID]: { ...receipt, at: Date.now() } } }));
}
