import { create } from 'zustand';
import { isOwnClick } from '@/lib/app-clicks';
import type { FormValues } from '@/lib/app-view-form';
import type { AppView, AppViewEvent } from '@/types';

// The app forms open in this tab: a stack, the one shown last. A form an
// app pushes goes on top (Back returns to the one under it); any other form
// starts a new stack. The dialog renders once at the chat root.
interface AppViewState {
  stack: AppViewEvent[];
}

export const useAppViewStore = create<AppViewState>(() => ({ stack: [] }));

// What the person typed in each form of the stack, so Back shows it again.
const drafts = new Map<string, FormValues>();

export const readDraft = (viewID: string) => drafts.get(viewID);

export const saveDraft = (viewID: string, values: FormValues) => void drafts.set(viewID, values);

const top = () => useAppViewStore.getState().stack.at(-1);

// openAppView shows a form the app opened or pushed — only in the tab that
// clicked.
export function openAppView(event: AppViewEvent): void {
  if (!isOwnClick(event.clickID)) return;
  const { stack } = useAppViewStore.getState();
  if (event.view.previous_view_id && top()?.view.id === event.view.previous_view_id) {
    useAppViewStore.setState({ stack: [...stack, event] });
    return;
  }
  drafts.clear();
  useAppViewStore.setState({ stack: [event] });
}

// updateAppView changes one of the open forms (views.update).
export function updateAppView(event: AppViewEvent): void {
  const { stack } = useAppViewStore.getState();
  if (!stack.some((e) => e.view.id === event.view.id)) return;
  useAppViewStore.setState({ stack: stack.map((e) => (e.view.id === event.view.id ? { ...e, view: event.view, app: event.app } : e)) });
}

// replaceAppView shows the app's next form in place of the top one.
export function replaceAppView(view: AppView): void {
  const { stack } = useAppViewStore.getState();
  const current = stack.at(-1);
  if (!current) return;
  useAppViewStore.setState({ stack: [...stack.slice(0, -1), { ...current, view }] });
}

// pushAppView puts the app's next form on top (a submission's push).
export function pushAppView(view: AppView): void {
  const { stack } = useAppViewStore.getState();
  const current = stack.at(-1);
  if (!current) return;
  useAppViewStore.setState({ stack: [...stack, { ...current, view }] });
}

// popAppView closes the top form; the one under it shows again.
export function popAppView(): void {
  const { stack } = useAppViewStore.getState();
  const current = stack.at(-1);
  if (current) drafts.delete(current.view.id);
  useAppViewStore.setState({ stack: stack.slice(0, -1) });
}

export function closeAppView(): void {
  drafts.clear();
  useAppViewStore.setState({ stack: [] });
}
