import { create } from 'zustand';

const APP_NAME = 'ex';

// The count the tab title carries (NotificationCountTitleBridge feeds it the
// Activity bell's). A zustand store, so every titled page re-renders with it.
const useDocumentTitleStore = create<{ notificationCount: number }>(() => ({ notificationCount: 0 }));

export function formatDocumentTitle(
  page: string | null | undefined,
  count = useDocumentTitleStore.getState().notificationCount,
): string {
  const base = page ? `${page} · ${APP_NAME}` : APP_NAME;
  return count > 0 ? `(${count}) ${base}` : base;
}

export function getDocumentNotificationCount(): number {
  return useDocumentTitleStore.getState().notificationCount;
}

export function setDocumentNotificationCount(count: number): void {
  const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (next === getDocumentNotificationCount()) return;
  useDocumentTitleStore.setState({ notificationCount: next });
}

export function useDocumentNotificationCount(): number {
  return useDocumentTitleStore((s) => s.notificationCount);
}
