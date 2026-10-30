import { create } from 'zustand';
import { isOwnClick } from '@/lib/app-clicks';
import type { AppView, AppViewEvent } from '@/types';

// The app form open in this tab, if any: the dialog renders once at the chat
// root and reads it from here. One form at a time — a new one takes the
// place of the last, as the app's next step.
interface AppViewState {
  current: AppViewEvent | null;
}

export const useAppViewStore = create<AppViewState>(() => ({ current: null }));

// openAppView shows a form the app opened — only in the tab that clicked.
export function openAppView(event: AppViewEvent): void {
  if (!isOwnClick(event.clickID)) return;
  useAppViewStore.setState({ current: event });
}

// updateAppView changes the open form (views.update), if it is this one.
export function updateAppView(event: AppViewEvent): void {
  const current = useAppViewStore.getState().current;
  if (current?.view.id !== event.view.id) return;
  useAppViewStore.setState({ current: { ...current, view: event.view, app: event.app } });
}

// replaceAppView shows the app's next form, its answer to a submission.
export function replaceAppView(view: AppView): void {
  const current = useAppViewStore.getState().current;
  if (!current) return;
  useAppViewStore.setState({ current: { ...current, view } });
}

export function closeAppView(): void {
  useAppViewStore.setState({ current: null });
}
