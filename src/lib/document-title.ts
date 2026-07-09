const APP_NAME = 'ex';

let notificationCount = 0;
const listeners = new Set<() => void>();

export function formatDocumentTitle(
  page: string | null | undefined,
  count = notificationCount,
): string {
  const base = page ? `${page} · ${APP_NAME}` : APP_NAME;
  return count > 0 ? `(${count}) ${base}` : base;
}

export function getDocumentNotificationCount(): number {
  return notificationCount;
}

export function setDocumentNotificationCount(count: number): void {
  const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (next === notificationCount) return;
  notificationCount = next;
  listeners.forEach((listener) => listener());
}

export function subscribeDocumentNotificationCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
