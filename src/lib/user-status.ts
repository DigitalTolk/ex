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
