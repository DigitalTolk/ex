import type { UserStatus } from '@/types';

export function activeStatus(status?: UserStatus | null): UserStatus | null {
  if (!status?.emoji || !status.text) return null;
  return status;
}

export function formatStatusUntil(clearAt?: string): string {
  if (!clearAt) return "won't clear automatically";
  return `until ${new Date(clearAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

// Compact "Until 7:00 PM" label for the account menu's status row: just the
// time when it clears today, date + time otherwise.
export function formatStatusUntilShort(clearAt?: string, now: Date = new Date()): string {
  if (!clearAt) return "Doesn't clear";
  const at = new Date(clearAt);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return `Until ${time}`;
  return `Until ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}
