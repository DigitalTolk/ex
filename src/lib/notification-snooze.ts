import type { NotificationSettings } from '@/types';

// Do Not Disturb inside ex (the server's notification snooze; lib/dnd is the
// OS's own Focus mode): while it is on, nothing alerts the user; everything
// still lands in Activity and on badges.

// A snooze this far ahead is "until I turn it back on": the server stores it
// as one that ends ten years out.
export const INDEFINITE_SNOOZE_MINUTES = 10 * 365 * 24 * 60;
const INDEFINITE_FROM_MS = 365 * 24 * 60 * 60 * 1000;

// snoozeEnd is when Do Not Disturb ends, or null while it is off (never set,
// or already over).
export function snoozeEnd(settings: NotificationSettings | null | undefined, now: number = Date.now()): Date | null {
  if (!settings?.snoozeUntil) return null;
  const end = new Date(settings.snoozeUntil);
  return end.getTime() > now ? end : null;
}

// minutesUntilTomorrow is how long to snooze so alerts come back at 9 the
// next morning, local time.
export function minutesUntilTomorrow(now: Date = new Date()): number {
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 0, 0, 0);
  return Math.ceil((morning.getTime() - now.getTime()) / 60_000);
}

// describeSnoozeEnd says when alerts come back: "until 3:30 PM", "until
// tomorrow, 9:00 AM", a date beyond that, or "until you turn them back on".
export function describeSnoozeEnd(end: Date, now: Date = new Date()): string {
  if (end.getTime() - now.getTime() > INDEFINITE_FROM_MS) return 'until you turn them back on';
  const time = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (end.toDateString() === now.toDateString()) return `until ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (end.toDateString() === tomorrow.toDateString()) return `until tomorrow, ${time}`;
  return `until ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}
