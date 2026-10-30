import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newClickID } from '@/lib/app-clicks';
import { openAppView, updateAppView, useAppViewStore } from '@/stores/app-view';
import type { AppView, AppViewEvent, InputBlock, ViewBlock, ViewSubmitResult } from '@/types';
import { AppViewHost } from './AppViewHost';
// The form is a lazy chunk; loaded here, with the file, so no test's wait
// includes its first import (slow under coverage and a loaded machine).
import './AppViewDialog';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
const mockToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));
const mobile = vi.hoisted(() => ({ on: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.on }));

const text = (t: string) => ({ type: 'plain_text' as const, text: t });
const rooms = [
  { text: text('Room A'), value: 'a' },
  { text: text('Room B'), value: 'b' },
];

const reason: InputBlock = {
  type: 'input',
  block_id: 'reason',
  label: text('Reason'),
  hint: text('Why the change?'),
  element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 20, placeholder: text('Say why') },
};
const when: InputBlock = {
  type: 'input',
  block_id: 'when',
  label: text('New date'),
  element: { type: 'datepicker', action_id: 'day', initial_date: '2026-11-02' },
};
const room: InputBlock = {
  type: 'input',
  block_id: 'room',
  label: text('Room'),
  element: { type: 'static_select', action_id: 'room', options: rooms, placeholder: text('Pick a room') },
};
const floor: InputBlock = {
  type: 'input',
  block_id: 'floor',
  label: text('Floor'),
  optional: true,
  element: { type: 'static_select', action_id: 'floor', options: [{ text: text('Ground'), value: 'g' }] },
};
const note: InputBlock = {
  type: 'input',
  block_id: 'note',
  label: text('Note'),
  optional: true,
  element: { type: 'plain_text_input', action_id: 'note', min_length: 3 },
};

// A form as an app sends it: message blocks around and between the fields.
const formView = (over: Partial<AppView> = {}): AppView => ({
  id: 'V1',
  type: 'modal',
  title: text('Reschedule A3'),
  submit: text('Save'),
  close: text('Not now'),
  hash: 'h1',
  blocks: [
    { type: 'section', block_id: 'intro', text: { type: 'markdown', text: 'A3 is due **Fri**.' } },
    { type: 'context', block_id: 'ctx', elements: [{ type: 'plain_text', text: 'Asked by Alice' }] },
    reason,
    when,
    { type: 'divider', block_id: 'div' },
    room,
    floor,
    note,
  ] as ViewBlock[],
  ...over,
});

const app = { name: 'MeetingMind', iconEmoji: 'calendar' };

type Route = (body: unknown) => unknown;
let routes: Record<string, Route>;

beforeEach(() => {
  mobile.on = false;
  mockToast.mockReset();
  routes = {};
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/v1/emojis') return Promise.resolve([{ name: 'meetingmind', imageURL: '/e/mm.png' }]);
    const route = routes[`${method} ${path}`];
    if (!route) return Promise.reject(new Error(`unexpected ${method} ${path}`));
    try {
      return Promise.resolve(route(init?.body ? JSON.parse(init.body) : undefined));
    } catch (err) {
      return Promise.reject(err);
    }
  });
});

// openForm opens a form the way the app does: answering a click this tab sent.
async function openForm(view: AppView = formView(), appInfo: AppViewEvent['app'] = app) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AppViewHost />
    </QueryClientProvider>,
  );
  act(() => openAppView({ view, app: appInfo, clickID: newClickID() }));
  return screen.findByTestId('app-view-dialog');
}

const fieldOf = (blockID: string, viewID = 'V1') => screen.getByTestId(`view-${viewID}-${blockID}`);
const noteOf = (blockID: string, viewID = 'V1') => screen.queryByTestId(`view-${viewID}-${blockID}-note`);
const submitCalls = () => mockApiFetch.mock.calls.filter(([path]) => String(path).endsWith('/submit'));
const sentValues = (n = 0) => (JSON.parse(submitCalls()[n][1].body as string) as { values: unknown }).values;
const type = (blockID: string, value: string) => fireEvent.change(fieldOf(blockID), { target: { value } });

describe('AppViewDialog', () => {
  it("shows the app's form: its name and icon, the title, the app's text, and each field", async () => {
    const dialog = await openForm();
    const appRow = within(dialog).getByTestId('app-view-app');
    expect(appRow).toHaveTextContent('MeetingMind');
    expect(within(appRow).getByTestId('app-view-icon')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Reschedule A3' })).toBeInTheDocument();
    expect(within(dialog).getByText('Fri')).toBeInTheDocument();
    expect(within(dialog).getByText('Asked by Alice')).toBeInTheDocument();

    // Labels name their fields; optional ones say so.
    expect(within(dialog).getByLabelText('Reason')).toBe(fieldOf('reason'));
    expect(fieldOf('reason').tagName).toBe('TEXTAREA');
    expect(fieldOf('reason')).toHaveAttribute('placeholder', 'Say why');
    expect(within(screen.getByTestId('view-field-note')).getByText('Optional')).toBeInTheDocument();
    expect(within(screen.getByTestId('view-field-room')).queryByText('Optional')).toBeNull();
    expect(fieldOf('note').tagName).toBe('INPUT');
    expect(fieldOf('note')).not.toHaveAttribute('aria-describedby');

    // The hint sits under its field and describes it.
    expect(noteOf('reason')).toHaveTextContent('Why the change?');
    expect(noteOf('reason')!.className).toContain('text-muted-foreground');
    expect(fieldOf('reason')).toHaveAttribute('aria-describedby', 'view-V1-reason-note');
    expect(fieldOf('reason')).not.toHaveAttribute('aria-invalid');

    // The date starts at the app's day.
    expect(screen.getByTestId('view-V1-when-trigger')).toHaveTextContent('2026');

    // A required select's placeholder can't be chosen back; an optional one's can.
    const roomSelect = fieldOf('room') as HTMLSelectElement;
    expect(roomSelect.value).toBe('');
    expect(roomSelect.options[0]).toHaveTextContent('Pick a room');
    expect(roomSelect.options[0].disabled).toBe(true);
    const floorSelect = fieldOf('floor') as HTMLSelectElement;
    expect(floorSelect.options[0]).toHaveTextContent('Choose…');
    expect(floorSelect.options[0].disabled).toBe(false);
    expect(roomSelect.parentElement!.className).toContain('[&_select]:text-muted-foreground');

    expect(screen.getByTestId('app-view-close')).toHaveTextContent('Not now');
    expect(screen.getByTestId('app-view-submit')).toHaveTextContent('Save');
  });

  it("draws an app's custom emoji icon, or its picture when ex can't draw the emoji", async () => {
    await openForm(formView(), { name: 'MeetingMind', iconEmoji: 'meetingmind' });
    expect(await screen.findByTestId('app-view-icon')).toBeInTheDocument();
  });

  it("shows the app's initials when it has no icon ex can draw", async () => {
    const dialog = await openForm(formView(), { name: 'Meeting Mind', iconEmoji: 'no_such_emoji_here' });
    expect(within(dialog).queryByTestId('app-view-icon')).toBeNull();
    expect(within(within(dialog).getByTestId('app-view-app')).getByText('MM')).toBeInTheDocument();
  });

  it('checks the form before sending, points at what to fix, then sends it and closes on the answer', async () => {
    routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'close', notice: 'Moved to Mon 2 Nov' });
    await openForm();
    type('reason', 'Out sick');
    fireEvent.click(screen.getByTestId('app-view-submit'));

    // Nothing went out: the room is required, and the note too short.
    expect(noteOf('room')).toHaveTextContent('Please choose one.');
    expect(noteOf('room')!.className).toContain('text-destructive');
    expect(fieldOf('room')).toHaveAttribute('aria-invalid', 'true');
    expect(fieldOf('room')).toHaveAttribute('aria-describedby', 'view-V1-room-note');
    expect(submitCalls()).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(fieldOf('room')));

    // Choosing a room clears its error at once.
    fireEvent.change(fieldOf('room'), { target: { value: 'b' } });
    expect(noteOf('room')).toBeNull();
    expect(fieldOf('room')).not.toHaveAttribute('aria-invalid');

    // An optional field is checked only once filled in.
    type('note', 'ok');
    fireEvent.click(screen.getByTestId('app-view-submit'));
    expect(noteOf('note')).toHaveTextContent('Use at least 3 characters.');
    await waitFor(() => expect(document.activeElement).toBe(fieldOf('note')));
    type('note', 'okay');

    fireEvent.click(screen.getByTestId('app-view-submit'));
    await waitFor(() => expect(useAppViewStore.getState().current).toBeNull());
    expect(screen.queryByTestId('app-view-dialog')).toBeNull();
    expect(sentValues()).toEqual({
      reason: { value: 'Out sick' },
      when: { day: '2026-11-02' },
      room: { room: 'b' },
      floor: { floor: '' },
      note: { note: 'okay' },
    });
    expect(mockToast).toHaveBeenCalledWith('Moved to Mon 2 Nov', 'success');
  });

  it("shows the app's errors under its fields and moves to the first, then sends the fix", async () => {
    let answer: ViewSubmitResult = { action: 'errors', errors: { note: 'Too vague', when: 'Mondays are full' } };
    routes['POST /api/v1/views/V1/submit'] = () => answer;
    await openForm();
    type('reason', 'Out sick');
    fireEvent.change(fieldOf('room'), { target: { value: 'a' } });
    fireEvent.click(screen.getByTestId('app-view-submit'));

    expect(await screen.findByText('Mondays are full')).toBeInTheDocument();
    expect(noteOf('note')).toHaveTextContent('Too vague');
    const trigger = screen.getByTestId('view-V1-when-trigger');
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAttribute('aria-describedby', 'view-V1-when-note');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.getByTestId('app-view-dialog')).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalled();

    // Fixing a field takes its error away; another field's stays.
    type('note', 'Flu, back Tuesday');
    expect(screen.queryByText('Too vague')).toBeNull();
    expect(screen.getByText('Mondays are full')).toBeInTheDocument();

    answer = { action: 'close' };
    fireEvent.click(screen.getByTestId('app-view-submit'));
    await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
    expect(sentValues(1)).toMatchObject({ note: { note: 'Flu, back Tuesday' } });
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('shows the next step the app answers with in place, keeping what still applies', async () => {
    const next = formView({
      title: text('Pick a room'),
      hash: 'h2',
      submit: undefined,
      close: undefined,
      blocks: [
        reason,
        { ...room, element: { ...room.element, initial_option: rooms[1] } as InputBlock['element'] },
        { ...note, block_id: 'extra', label: text('Anything else') },
      ],
    });
    routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'update', view: next, notice: 'Saved so far' });
    await openForm();
    type('reason', 'Out sick');
    fireEvent.change(fieldOf('room'), { target: { value: 'a' } });
    fireEvent.click(screen.getByTestId('app-view-submit'));

    expect(await screen.findByRole('heading', { name: 'Pick a room' })).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('Saved so far', 'success');
    // Kept as it was: what was typed stays. Changed: the app's new value.
    expect(fieldOf('reason')).toHaveValue('Out sick');
    expect(fieldOf('room')).toHaveValue('b');
    expect(fieldOf('extra')).toHaveValue('');
    expect(screen.queryByTestId('view-field-when')).toBeNull();
    // No submit button, and Cancel by default.
    expect(screen.queryByTestId('app-view-submit')).toBeNull();
    expect(screen.getByTestId('app-view-close')).toHaveTextContent('Cancel');
    expect(screen.getByTestId('app-view-form').querySelector('button[type="submit"]')).toBeDisabled();
  });

  it('picks a new date on the calendar inside the form, and sends it', async () => {
    routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'close' });
    await openForm();
    type('reason', 'Out sick');
    fireEvent.change(fieldOf('room'), { target: { value: 'a' } });
    fireEvent.click(screen.getByTestId('view-V1-when-trigger'));
    await screen.findByTestId('view-V1-when-calendar');
    fireEvent.click(document.querySelector(`button[data-day="${new Date(2026, 10, 18).toLocaleDateString()}"]`)!);
    await waitFor(() => expect(screen.queryByTestId('view-V1-when-calendar')).toBeNull());
    // The form is still open; a required date offers no clear button.
    expect(screen.getByTestId('app-view-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('view-V1-when-clear')).toBeNull();

    fireEvent.click(screen.getByTestId('app-view-submit'));
    await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
    expect(sentValues()).toMatchObject({ when: { day: '2026-11-18' } });
  });

  it('follows a live change to the open form, keeping what the person typed', async () => {
    await openForm();
    type('reason', 'Out sick');
    fireEvent.click(screen.getByTestId('app-view-submit'));
    expect(noteOf('room')).toHaveTextContent('Please choose one.');

    act(() => updateAppView({ view: formView({ title: text('Reschedule A3 (2 left)'), hash: 'h2' }), app }));
    expect(await screen.findByRole('heading', { name: 'Reschedule A3 (2 left)' })).toBeInTheDocument();
    expect(fieldOf('reason')).toHaveValue('Out sick');
    // Checks from before the change are gone; the app's form is new.
    expect(noteOf('room')).toBeNull();

    // Another form's update leaves this one alone.
    act(() => updateAppView({ view: formView({ id: 'V9', title: text('Other'), hash: 'h3' }), app }));
    expect(screen.getByRole('heading', { name: 'Reschedule A3 (2 left)' })).toBeInTheDocument();
  });

  it('starts fresh when the app opens a different form', async () => {
    await openForm();
    type('reason', 'Out sick');
    act(() => openAppView({ view: formView({ id: 'V2', title: text('Second form') }), app, clickID: newClickID() }));
    expect(await screen.findByRole('heading', { name: 'Second form' })).toBeInTheDocument();
    expect(fieldOf('reason', 'V2')).toHaveValue('');
  });

  it('closes when the app answers an update without a form', async () => {
    routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'update', notice: "Couldn't reach the room service", failed: true });
    await openForm();
    type('reason', 'Out sick');
    fireEvent.change(fieldOf('room'), { target: { value: 'a' } });
    fireEvent.click(screen.getByTestId('app-view-submit'));
    await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
    expect(mockToast).toHaveBeenCalledWith("Couldn't reach the room service", 'error');
  });

  it("keeps the form open with a note when the app didn't take it, and lets the person retry", async () => {
    let answer: () => unknown = () => ({ action: 'keep', notice: 'MeetingMind is busy, try again' });
    routes['POST /api/v1/views/V1/submit'] = () => answer();
    await openForm();
    type('reason', 'Out sick');
    fireEvent.change(fieldOf('room'), { target: { value: 'a' } });
    const submit = screen.getByTestId('app-view-submit');

    fireEvent.click(submit);
    expect(await screen.findByTestId('app-view-banner')).toHaveTextContent('MeetingMind is busy, try again');
    expect(mockToast).not.toHaveBeenCalled();

    answer = () => ({ action: 'keep' });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId('app-view-banner')).toHaveTextContent("That didn't go through. Try again."));

    answer = () => {
      throw new Error('MeetingMind took too long');
    };
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId('app-view-banner')).toHaveTextContent('MeetingMind took too long'));

    answer = () => {
      throw new Error('');
    };
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId('app-view-banner')).toHaveTextContent("That didn't go through. Try again."));

    mockApiFetch.mockImplementationOnce(() => Promise.reject('offline'));
    fireEvent.click(submit);
    await waitFor(() => expect(submitCalls()).toHaveLength(5));
    await waitFor(() => expect(submit).not.toBeDisabled());
    expect(screen.getByTestId('app-view-banner')).toHaveTextContent("That didn't go through. Try again.");

    // An "errors" answer without any errors is just a note.
    answer = () => ({ action: 'errors', notice: 'Nothing to change' });
    fireEvent.click(submit);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Nothing to change', 'success'));
    expect(screen.queryByTestId('app-view-banner')).toBeNull();
    expect(screen.getByTestId('app-view-dialog')).toBeInTheDocument();
  });

  it('sends once while a submission is on its way, showing it is busy', async () => {
    let release: (v: ViewSubmitResult) => void = () => {};
    routes['POST /api/v1/views/V1/submit'] = () => new Promise<ViewSubmitResult>((resolve) => (release = resolve));
    await openForm();
    type('reason', 'Out sick');
    fireEvent.change(fieldOf('room'), { target: { value: 'a' } });
    fireEvent.click(screen.getByTestId('app-view-submit'));

    const submit = screen.getByTestId('app-view-submit');
    await waitFor(() => expect(submit).toBeDisabled());
    expect(submit).toHaveAttribute('aria-busy', 'true');
    expect(within(submit).getByLabelText('Sending')).toBeInTheDocument();
    // Enter in a field submits the form, but not a second time.
    fireEvent.submit(screen.getByTestId('app-view-form'));
    expect(submitCalls()).toHaveLength(1);

    await act(async () => release({ action: 'close' }));
    await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
  });

  it('sends a multi-line field with ⌘ or Ctrl+Enter, while Enter alone is a new line', async () => {
    routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'keep', notice: 'Got it' });
    await openForm();
    fireEvent.change(fieldOf('room'), { target: { value: 'a' } });
    type('reason', 'Out sick');
    fireEvent.keyDown(fieldOf('reason'), { key: 'Enter' });
    fireEvent.keyDown(fieldOf('reason'), { key: 'a', metaKey: true });
    expect(submitCalls()).toHaveLength(0);

    fireEvent.keyDown(fieldOf('reason'), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    await screen.findByText('Got it');
    fireEvent.keyDown(fieldOf('reason'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(submitCalls()).toHaveLength(2));
  });

  it('counts characters as a text field nears its limit, and flags going over', async () => {
    await openForm();
    const count = () => screen.queryByTestId('view-V1-reason-count');
    type('reason', 'x'.repeat(15));
    expect(count()).toBeNull();
    type('reason', 'x'.repeat(16));
    expect(count()).toHaveTextContent('16/20');
    expect(count()!.className).not.toContain('text-destructive');
    type('reason', '🙂'.repeat(21));
    expect(count()).toHaveTextContent('21/20');
    expect(count()!.className).toContain('text-destructive');
    // A field with no limit shows no count.
    type('note', 'x'.repeat(500));
    expect(screen.queryByTestId('view-V1-note-count')).toBeNull();

    fireEvent.click(screen.getByTestId('app-view-submit'));
    expect(noteOf('reason')).toHaveTextContent('Keep it to 20 characters.');
  });

  it('tells the server the form was dismissed when the person cancels', async () => {
    routes['POST /api/v1/views/V1/close'] = () => ({});
    await openForm();
    fireEvent.click(screen.getByTestId('app-view-close'));
    await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/views/V1/close', { method: 'POST' });
    expect(useAppViewStore.getState().current).toBeNull();
  });

  it("closes on Escape even when the server can't be told", async () => {
    await openForm();
    fireEvent.keyDown(screen.getByTestId('app-view-dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/views/V1/close', { method: 'POST' }));
  });

  describe('on a phone', () => {
    const topBarAction = () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-mobile-action"]');

    it('puts the submit in the top bar and drops the footer', async () => {
      mobile.on = true;
      let release: (v: ViewSubmitResult) => void = () => {};
      routes['POST /api/v1/views/V1/submit'] = () => new Promise<ViewSubmitResult>((resolve) => (release = resolve));
      await openForm();
      expect(screen.queryByTestId('app-view-submit')).toBeNull();
      expect(screen.queryByTestId('app-view-close')).toBeNull();
      expect(topBarAction()).toHaveTextContent('Save');
      expect(document.querySelector('[data-slot="dialog-mobile-close"]')).toHaveAttribute('aria-label', 'Not now');

      type('reason', 'Out sick');
      fireEvent.change(fieldOf('room'), { target: { value: 'a' } });
      fireEvent.click(topBarAction()!);
      await waitFor(() => expect(topBarAction()).toBeDisabled());
      await act(async () => release({ action: 'close' }));
      await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
      expect(submitCalls()).toHaveLength(1);
    });

    it('shows no top-bar action for a form without a submit button', async () => {
      mobile.on = true;
      await openForm(formView({ submit: undefined }));
      expect(topBarAction()).toBeNull();
    });
  });
});
