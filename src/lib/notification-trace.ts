// notification-trace records the decision path of every notification this
// tab processes (SPEC P4 / G-P4.1): why it surfaced, suppressed, deduped,
// held, or acked — with the attention verdicts at each gate. When an alert
// "never arrived", this ring buffer is the difference between a shrug and a
// diagnosis. Always recording (bounded, in-memory, no I/O); the localStorage
// debug flag additionally mirrors entries to the console for live debugging.

import { readJSON } from '@/lib/storage';

export interface NotificationTraceEntry {
  at: number;
  step: string;
  messageID?: string;
  detail?: Record<string, unknown>;
}

export const NOTIFICATION_TRACE_FLAG_KEY = 'ex.notif.trace.v1';

const CAPACITY = 100;
const entries: NotificationTraceEntry[] = [];

export function traceNotification(
  step: string,
  messageID?: string,
  detail?: Record<string, unknown>,
): void {
  entries.push({ at: Date.now(), step, messageID, detail });
  if (entries.length > CAPACITY) entries.shift();
  if (readJSON<boolean>(NOTIFICATION_TRACE_FLAG_KEY, false)) {
    console.debug('[notif]', step, messageID ?? '', detail ?? '');
  }
}

// getNotificationTrace returns a copy, newest last — consumed by the
// diagnostics readout in the notification settings.
export function getNotificationTrace(): NotificationTraceEntry[] {
  return [...entries];
}

export function resetNotificationTraceForTests(): void {
  entries.length = 0;
}
