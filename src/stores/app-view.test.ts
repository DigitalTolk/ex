import { describe, expect, it } from 'vitest';
import { newClickID } from '@/lib/app-clicks';
import type { AppView, AppViewEvent } from '@/types';
import { closeAppView, openAppView, replaceAppView, updateAppView, useAppViewStore } from './app-view';

const view = (id: string, hash = 'h1', title = 'Reschedule'): AppView => ({
  id,
  type: 'modal',
  title: { type: 'plain_text', text: title },
  blocks: [],
  hash,
});
const app = { name: 'MeetingMind', iconEmoji: 'calendar' };
const current = () => useAppViewStore.getState().current;

describe('app view store', () => {
  it('opens a form only in the tab whose click it answers', () => {
    openAppView({ view: view('V1'), app, clickID: 'another-tab' });
    expect(current()).toBeNull();
    openAppView({ view: view('V1'), app });
    expect(current()).toBeNull();

    const event: AppViewEvent = { view: view('V1'), app, clickID: newClickID() };
    openAppView(event);
    expect(current()).toEqual(event);
  });

  it('changes the open form when the app updates that one, and no other', () => {
    updateAppView({ view: view('V1', 'h2'), app });
    expect(current()).toBeNull();

    const clickID = newClickID();
    openAppView({ view: view('V1'), app, clickID });
    updateAppView({ view: view('V2', 'h2', 'Other'), app });
    expect(current()?.view.title.text).toBe('Reschedule');

    const renamed = { name: 'MeetingMind 2' };
    updateAppView({ view: view('V1', 'h2', 'Pick a room'), app: renamed });
    expect(current()).toEqual({ view: view('V1', 'h2', 'Pick a room'), app: renamed, clickID });
  });

  it("shows the app's next form in place of the open one", () => {
    replaceAppView(view('V2'));
    expect(current()).toBeNull();

    const clickID = newClickID();
    openAppView({ view: view('V1'), app, clickID });
    replaceAppView(view('V2', 'h9', 'Confirm'));
    expect(current()).toEqual({ view: view('V2', 'h9', 'Confirm'), app, clickID });
  });

  it('closes the form', () => {
    openAppView({ view: view('V1'), app, clickID: newClickID() });
    closeAppView();
    expect(current()).toBeNull();
  });
});
