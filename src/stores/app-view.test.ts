import { describe, expect, it } from 'vitest';
import { newClickID } from '@/lib/app-clicks';
import type { AppView, AppViewEvent } from '@/types';
import {
  closeAppView,
  openAppView,
  popAppView,
  pushAppView,
  readDraft,
  replaceAppView,
  saveDraft,
  updateAppView,
  useAppViewStore,
} from './app-view';

const view = (id: string, hash = 'h1', title = 'Reschedule', over: Partial<AppView> = {}): AppView => ({
  id,
  type: 'modal',
  title: { type: 'plain_text', text: title },
  blocks: [],
  hash,
  ...over,
});
const app = { name: 'MeetingMind', iconEmoji: 'calendar' };
const stack = () => useAppViewStore.getState().stack;
const current = () => stack().at(-1);
const ids = () => stack().map((e) => e.view.id);

describe('app view store', () => {
  it('opens a form only in the tab whose click it answers', () => {
    openAppView({ view: view('V1'), app, clickID: 'another-tab' });
    expect(stack()).toEqual([]);
    openAppView({ view: view('V1'), app });
    expect(stack()).toEqual([]);

    const event: AppViewEvent = { view: view('V1'), app, clickID: newClickID() };
    openAppView(event);
    expect(stack()).toEqual([event]);
  });

  it('pushes a form the app opened on top of the shown one, and starts over for any other', () => {
    openAppView({ view: view('V1'), app, clickID: newClickID() });
    saveDraft('V1', { reason: 'Out sick' });

    // A form pushed over the one shown goes on top; the draft under it stays.
    openAppView({ view: view('V2', 'h1', 'Step 2', { previous_view_id: 'V1', root_view_id: 'V1' }), app, clickID: newClickID() });
    expect(ids()).toEqual(['V1', 'V2']);
    expect(readDraft('V1')).toEqual({ reason: 'Out sick' });

    // A form that names another form under it (not the one shown) starts a new stack,
    // and the old drafts go with the old stack.
    openAppView({ view: view('V3', 'h1', 'Elsewhere', { previous_view_id: 'V1' }), app, clickID: newClickID() });
    expect(ids()).toEqual(['V3']);
    expect(readDraft('V1')).toBeUndefined();

    // As does any form with nothing under it.
    openAppView({ view: view('V4'), app, clickID: newClickID() });
    expect(ids()).toEqual(['V4']);
  });

  it('changes the open form when the app updates that one, and no other', () => {
    updateAppView({ view: view('V1', 'h2'), app });
    expect(stack()).toEqual([]);

    const clickID = newClickID();
    openAppView({ view: view('V1'), app, clickID });
    updateAppView({ view: view('V2', 'h2', 'Other'), app });
    expect(current()?.view.title.text).toBe('Reschedule');

    const renamed = { name: 'MeetingMind 2' };
    updateAppView({ view: view('V1', 'h2', 'Pick a room'), app: renamed });
    expect(stack()).toEqual([{ view: view('V1', 'h2', 'Pick a room'), app: renamed, clickID }]);
  });

  it('updates a form under the top one in its place, leaving the top shown', () => {
    const clickID = newClickID();
    openAppView({ view: view('V1'), app, clickID });
    pushAppView(view('V2', 'h1', 'Step 2'));
    updateAppView({ view: view('V1', 'h2', 'Step 1 (changed)'), app });
    expect(stack().map((e) => e.view.title.text)).toEqual(['Step 1 (changed)', 'Step 2']);
    expect(current()?.view.id).toBe('V2');
  });

  it("shows the app's next form in place of the top one", () => {
    replaceAppView(view('V2'));
    expect(stack()).toEqual([]);

    const clickID = newClickID();
    openAppView({ view: view('V1'), app, clickID });
    replaceAppView(view('V2', 'h9', 'Confirm'));
    expect(stack()).toEqual([{ view: view('V2', 'h9', 'Confirm'), app, clickID }]);
  });

  it("pushes the app's next form on top, and Back pops it with its draft", () => {
    pushAppView(view('V2'));
    expect(stack()).toEqual([]);

    const clickID = newClickID();
    openAppView({ view: view('V1'), app, clickID });
    pushAppView(view('V2', 'h1', 'Step 2'));
    expect(stack()).toEqual([
      { view: view('V1'), app, clickID },
      { view: view('V2', 'h1', 'Step 2'), app, clickID },
    ]);

    saveDraft('V1', { reason: 'a' });
    saveDraft('V2', { room: 'b' });
    popAppView();
    expect(ids()).toEqual(['V1']);
    expect(readDraft('V2')).toBeUndefined();
    expect(readDraft('V1')).toEqual({ reason: 'a' });

    popAppView();
    expect(stack()).toEqual([]);
    // Popping an empty stack is harmless.
    popAppView();
    expect(stack()).toEqual([]);
  });

  it('closes every form and forgets their drafts', () => {
    openAppView({ view: view('V1'), app, clickID: newClickID() });
    pushAppView(view('V2'));
    saveDraft('V1', { reason: 'a' });
    closeAppView();
    expect(stack()).toEqual([]);
    expect(readDraft('V1')).toBeUndefined();
  });
});
