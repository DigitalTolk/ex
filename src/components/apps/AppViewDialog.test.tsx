import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newClickID } from '@/lib/app-clicks';
import { openAppView, readDraft, updateAppView, useAppViewStore } from '@/stores/app-view';
import { useActionReceipts } from '@/stores/action-receipts';
import type { AppView, AppViewEvent, InputBlock, Message, ViewBlock, ViewSubmitResult } from '@/types';
import { BlockList, MessageBlockScope } from '@/components/chat/blocks/MessageBlocks';
import { AppViewHost } from './AppViewHost';
import '@/components/apps/SentDetailsDialog';
// The form is a lazy chunk; loaded here, with the file, so no test's wait
// includes its first import (slow under coverage and a loaded machine).
import AppViewDialog from './AppViewDialog';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
const mockToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));
const mobile = vi.hoisted(() => ({ on: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.on }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-alice', displayName: 'Alice' } }) }));

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
const closeBody = (n = 0) => {
  const call = mockApiFetch.mock.calls.filter(([path]) => String(path).endsWith('/close'))[n];
  return call ? (JSON.parse(call[1].body as string) as unknown) : undefined;
};
const type = (blockID: string, value: string, viewID = 'V1') => fireEvent.change(fieldOf(blockID, viewID), { target: { value } });
// The confirmation a finished form shows: each answer's label and text.
const sentPanel = () => screen.findByTestId('app-view-sent');
const answersShown = () =>
  Array.from(screen.getByLabelText('What you sent').querySelectorAll('dt')).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);

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

  it('draws as the first form of its stack when shown on its own', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AppViewDialog event={{ view: formView(), app, clickID: newClickID() }} />
      </QueryClientProvider>,
    );
    await screen.findByTestId('app-view-dialog');
    expect(screen.queryByTestId('app-view-back')).toBeNull();
    expect(screen.getByTestId('app-view-close')).toHaveTextContent('Not now');
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

  it('checks the form before sending, points at what to fix, then sends it and confirms what was sent', async () => {
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
    // The form doesn't vanish: it says where it went, what the app said, and
    // what was sent — option text, the date written out — leaving out the
    // optional field left empty.
    const sent = await sentPanel();
    expect(within(sent).getByRole('status')).toHaveTextContent('Sent to MeetingMind');
    expect(within(sent).getByText('Moved to Mon 2 Nov')).toBeInTheDocument();
    expect(answersShown()).toEqual([
      ['Reason', 'Out sick'],
      ['New date', 'Mon, Nov 2, 2026'],
      ['Room', 'Room B'],
      ['Note', 'okay'],
    ]);
    expect(screen.queryByTestId('app-view-form')).toBeNull();
    expect(screen.queryByTestId('app-view-submit')).toBeNull();
    // The app's note shows here, not in a toast too.
    expect(mockToast).not.toHaveBeenCalled();
    expect(sentValues()).toEqual({
      reason: { value: 'Out sick' },
      when: { day: '2026-11-02' },
      room: { room: 'b' },
      floor: { floor: '' },
      note: { note: 'okay' },
    });

    // Done closes it; the server already has the form closed, so it isn't told again.
    expect(screen.getByTestId('app-view-done')).toHaveFocus();
    fireEvent.click(screen.getByTestId('app-view-done'));
    await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
    expect(useAppViewStore.getState().stack).toEqual([]);
    expect(closeBody()).toBeUndefined();
  });

  it("names a person ex can't find as someone in the confirmation", async () => {
    routes['POST /api/v1/users/batch'] = () => [];
    routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'close' });
    await openForm(
      formView({ blocks: [{ type: 'input', block_id: 'owner', label: text('Owner'), element: { type: 'users_select', action_id: 'o', initial_user: 'u-gone' } }] }),
    );
    fireEvent.click(screen.getByTestId('app-view-submit'));
    await sentPanel();
    await waitFor(() => expect(answersShown()).toEqual([['Owner', 'Someone']]));
  });

  it('confirms a form sent with nothing filled in, and closes it on Escape without telling the server again', async () => {
    routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'close' });
    await openForm(formView({ blocks: [note] }));
    fireEvent.click(screen.getByTestId('app-view-submit'));
    const sent = await sentPanel();
    expect(within(sent).getByRole('status')).toHaveTextContent(/^Sent to MeetingMind$/);
    expect(screen.queryByLabelText('What you sent')).toBeNull();

    fireEvent.keyDown(screen.getByTestId('app-view-dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
    expect(useAppViewStore.getState().stack).toEqual([]);
    expect(closeBody()).toBeUndefined();
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
    await sentPanel();
    expect(answersShown()).toContainEqual(['Note', 'Flu, back Tuesday']);
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
    await sentPanel();
    expect(answersShown()).toContainEqual(['New date', 'Wed, Nov 18, 2026']);
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
    expect(await sentPanel()).toBeInTheDocument();
    expect(submitCalls()).toHaveLength(1);
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
    // It says the whole stack closed, with what the person had entered.
    expect(closeBody()).toEqual({
      all: true,
      values: { reason: { value: '' }, when: { day: '2026-11-02' }, room: { room: '' }, floor: { floor: '' }, note: { note: '' } },
    });
    expect(useAppViewStore.getState().stack).toEqual([]);
  });

  it("closes on Escape even when the server can't be told", async () => {
    await openForm();
    fireEvent.keyDown(screen.getByTestId('app-view-dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
    await waitFor(() => expect(closeBody()).toMatchObject({ all: true }));
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
      await act(async () => release({ action: 'close', notice: 'Moved' }));

      // Sent: the top bar offers Done, and the close button says Close.
      await sentPanel();
      expect(topBarAction()).toHaveTextContent('Done');
      expect(topBarAction()).not.toBeDisabled();
      expect(document.querySelector('[data-slot="dialog-mobile-close"]')).toHaveAttribute('aria-label', 'Close');
      expect(screen.queryByTestId('app-view-done')).toBeNull();
      expect(mockToast).not.toHaveBeenCalled();
      fireEvent.click(topBarAction()!);
      await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
      expect(submitCalls()).toHaveLength(1);
      expect(closeBody()).toBeUndefined();
    });

    it("closes a sent form from the top bar's close button without telling the server again", async () => {
      mobile.on = true;
      routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'close' });
      await openForm(formView({ blocks: [note] }));
      fireEvent.click(topBarAction()!);
      await sentPanel();
      fireEvent.click(document.querySelector<HTMLButtonElement>('[data-slot="dialog-mobile-close"]')!);
      await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
      expect(useAppViewStore.getState().stack).toEqual([]);
      expect(closeBody()).toBeUndefined();
    });

    it('shows no top-bar action for a form without a submit button', async () => {
      mobile.on = true;
      await openForm(formView({ submit: undefined }));
      expect(topBarAction()).toBeNull();
    });
  });

  describe('a stack of forms', () => {
    const step2 = formView({
      id: 'V2',
      hash: 's2',
      title: text('Pick a time'),
      submit: text('Book'),
      close: text('Never shown'),
      previous_view_id: 'V1',
      blocks: [{ type: 'input', block_id: 'slot', label: text('Slot'), element: { type: 'plain_text_input', action_id: 'slot' } }],
    });
    const fill = () => {
      type('reason', 'Out sick');
      fireEvent.change(fieldOf('room'), { target: { value: 'b' } });
    };

    it('shows the form the app pushes on top, and Back returns to the one under it as it was left', async () => {
      routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'push', view: step2 });
      routes['POST /api/v1/views/V2/close'] = () => ({});
      await openForm();
      fill();
      fireEvent.click(screen.getByTestId('app-view-submit'));

      expect(await screen.findByRole('heading', { name: 'Pick a time' })).toBeInTheDocument();
      expect(useAppViewStore.getState().stack.map((e) => e.view.id)).toEqual(['V1', 'V2']);
      // A pushed form goes back, not away: an arrow by the app's name, and Back in the footer.
      expect(screen.getByTestId('app-view-close')).toHaveTextContent('Back');
      expect(screen.getByTestId('app-view-back')).toHaveAccessibleName('Back');
      type('slot', '10:00', 'V2');

      fireEvent.click(screen.getByTestId('app-view-back'));
      expect(await screen.findByRole('heading', { name: 'Reschedule A3' })).toBeInTheDocument();
      // The first form shows what the person had entered.
      expect(fieldOf('reason')).toHaveValue('Out sick');
      expect(fieldOf('room')).toHaveValue('b');
      expect(screen.queryByTestId('app-view-back')).toBeNull();
      expect(screen.getByTestId('app-view-close')).toHaveTextContent('Not now');
      // The app hears that only the top form closed, with what it held.
      await waitFor(() => expect(closeBody()).toEqual({ all: false, values: { slot: { slot: '10:00' } } }));
      expect(readDraft('V2')).toBeUndefined();
    });

    it('goes Back from the footer too', async () => {
      routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'push', view: step2 });
      await openForm();
      fill();
      fireEvent.click(screen.getByTestId('app-view-submit'));
      await screen.findByRole('heading', { name: 'Pick a time' });
      // The server can't be told: Back still works.
      fireEvent.click(screen.getByTestId('app-view-close'));
      expect(await screen.findByRole('heading', { name: 'Reschedule A3' })).toBeInTheDocument();
      expect(useAppViewStore.getState().stack).toHaveLength(1);
    });

    it("closes every form when the person closes a pushed one, or the app's answer clears them", async () => {
      routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'push', view: step2 });
      routes['POST /api/v1/views/V2/close'] = () => ({});
      routes['POST /api/v1/views/V2/submit'] = (): ViewSubmitResult => ({ action: 'close', cleared: true, notice: 'Booked' });
      await openForm();
      fill();
      fireEvent.click(screen.getByTestId('app-view-submit'));
      await screen.findByRole('heading', { name: 'Pick a time' });

      // Escape closes the whole stack, not just the top.
      fireEvent.keyDown(screen.getByTestId('app-view-dialog'), { key: 'Escape' });
      await waitFor(() => expect(useAppViewStore.getState().stack).toEqual([]));
      expect(closeBody()).toEqual({ all: true, values: { slot: { slot: '' } } });
      await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());

      // Again, and this time the app's answer clears the stack.
      act(() => openAppView({ view: formView(), app, clickID: newClickID() }));
      await screen.findByRole('heading', { name: 'Reschedule A3' });
      fill();
      fireEvent.click(screen.getByTestId('app-view-submit'));
      await screen.findByRole('heading', { name: 'Pick a time' });
      type('slot', '11:00', 'V2');
      fireEvent.click(screen.getByTestId('app-view-submit'));
      // Done, though not the first form: the confirmation, with the app's note.
      const sent = await sentPanel();
      expect(within(sent).getByText('Booked')).toBeInTheDocument();
      expect(answersShown()).toEqual([['Slot', '11:00']]);
      expect(mockToast).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('app-view-done'));
      await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
      expect(useAppViewStore.getState().stack).toEqual([]);
      // Only the Escape above told the server; the cleared stack needs no word.
      expect(closeBody(1)).toBeUndefined();
    });

    it("returns to the form under it when the app closes a pushed one", async () => {
      routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'push', view: step2 });
      routes['POST /api/v1/views/V2/submit'] = (): ViewSubmitResult => ({ action: 'close' });
      await openForm();
      fill();
      fireEvent.click(screen.getByTestId('app-view-submit'));
      await screen.findByRole('heading', { name: 'Pick a time' });
      type('slot', '11:00', 'V2');
      fireEvent.click(screen.getByTestId('app-view-submit'));
      expect(await screen.findByRole('heading', { name: 'Reschedule A3' })).toBeInTheDocument();
      expect(fieldOf('reason')).toHaveValue('Out sick');
    });

    it('closes when the app answers a push without a form', async () => {
      routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'push' });
      await openForm();
      fill();
      fireEvent.click(screen.getByTestId('app-view-submit'));
      await waitFor(() => expect(useAppViewStore.getState().stack).toEqual([]));
    });

    it('shows a form the app pushes from a button in this one, and Back on a phone from the arrow', async () => {
      mobile.on = true;
      routes['POST /api/v1/views/V2/close'] = () => ({});
      await openForm();
      fill();
      act(() => openAppView({ view: step2, app, clickID: newClickID() }));
      expect(await screen.findByRole('heading', { name: 'Pick a time' })).toBeInTheDocument();
      expect(document.querySelector('[data-slot="dialog-mobile-close"]')).toHaveAttribute('aria-label', 'Back');
      fireEvent.click(screen.getByTestId('app-view-back'));
      expect(await screen.findByRole('heading', { name: 'Reschedule A3' })).toBeInTheDocument();
      expect(fieldOf('reason')).toHaveValue('Out sick');
    });
  });

  describe('changes the app asked to hear about', () => {
    const actionCalls = () => mockApiFetch.mock.calls.filter(([path]) => String(path) === '/api/v1/views/V1/actions');
    const actionBody = (n = 0) => JSON.parse(actionCalls()[n][1].body as string) as Record<string, unknown>;
    const live = () =>
      formView({
        blocks: [
          { ...reason, dispatch_action: true },
          { ...room, dispatch_action: true },
          note,
          {
            type: 'actions',
            block_id: 'tools',
            elements: [
              { type: 'button', action_id: 'refresh', text: text('Refresh rooms') },
              { type: 'static_select', action_id: 'sort', options: [{ text: text('By size'), value: 'size' }], placeholder: text('Sort') },
            ],
          },
        ] as ViewBlock[],
      });

    it('sends a pick at once, with the form as it stands', async () => {
      routes['POST /api/v1/views/V1/actions'] = () => ({ notice: 'Room B has a projector' });
      await openForm(live());
      fireEvent.change(fieldOf('room'), { target: { value: 'b' } });
      await waitFor(() => expect(actionCalls()).toHaveLength(1));
      expect(actionBody()).toMatchObject({ blockID: 'room', actionID: 'room', value: 'b' });
      expect(actionBody().values).toMatchObject({ reason: { value: '' }, note: { note: '' } });
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Room B has a projector', 'success'));
      // A field that doesn't send changes stays quiet.
      type('note', 'hello');
      expect(actionCalls()).toHaveLength(1);
    });

    it('sends typing only once the person pauses', async () => {
      routes['POST /api/v1/views/V1/actions'] = () => ({});
      await openForm(live());
      vi.useFakeTimers();
      try {
        type('reason', 'Out');
        act(() => vi.advanceTimersByTime(500));
        type('reason', 'Out sick');
        act(() => vi.advanceTimersByTime(699));
        expect(actionCalls()).toHaveLength(0);
        await act(async () => vi.advanceTimersByTime(1));
        expect(actionCalls()).toHaveLength(1);
        expect(actionBody()).toMatchObject({ blockID: 'reason', actionID: 'value', value: 'Out sick', values: { reason: { value: 'Out sick' } } });
      } finally {
        vi.useRealTimers();
      }
      expect(mockToast).not.toHaveBeenCalled();
    });

    it('drops a pending change when the form closes before the pause ends', async () => {
      routes['POST /api/v1/views/V1/close'] = () => ({});
      await openForm(live());
      vi.useFakeTimers();
      try {
        type('reason', 'Out');
        fireEvent.click(screen.getByTestId('app-view-close'));
        await act(async () => vi.advanceTimersByTime(1000));
      } finally {
        vi.useRealTimers();
      }
      await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
      expect(actionCalls()).toHaveLength(0);
    });

    it("sends a button or picker in the form to the form's actions, and shows the app's answer", async () => {
      let answer: () => unknown = () => ({ notice: "Couldn't reach the rooms", failed: true });
      routes['POST /api/v1/views/V1/actions'] = () => answer();
      await openForm(live());
      type('note', 'hello');

      const refresh = screen.getByTestId('block-button-refresh');
      expect(refresh).not.toBeDisabled();
      fireEvent.click(refresh);
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith("Couldn't reach the rooms", 'error'));
      // A button sends no value, but the form as it stands.
      expect(actionBody()).toEqual({
        blockID: 'tools',
        actionID: 'refresh',
        values: { reason: { value: '' }, room: { room: '' }, note: { note: 'hello' } },
      });

      answer = () => {
        throw new Error('form expired');
      };
      fireEvent.change(screen.getByTestId('view-V1-tools-sort'), { target: { value: 'size' } });
      await waitFor(() => expect(mockToast).toHaveBeenLastCalledWith('form expired'));
      expect(actionBody(1)).toMatchObject({ blockID: 'tools', actionID: 'sort', value: 'size' });

      answer = () => {
        throw new Error('');
      };
      fireEvent.click(refresh);
      await waitFor(() => expect(mockToast).toHaveBeenLastCalledWith("That didn't go through. Try again."));
      await waitFor(() => expect(refresh).not.toBeDisabled());
    });
  });

  describe('every kind of field', () => {
    const opt = (value: string, label = value) => ({ text: text(label), value });
    const kinds = formView({
      id: 'V7',
      hash: 'k1',
      blocks: [
        { type: 'input', block_id: 'guests', label: text('Guests'), element: { type: 'number_input', action_id: 'n', min_value: '1', placeholder: text('How many') } },
        { type: 'input', block_id: 'budget', label: text('Budget'), optional: true, element: { type: 'number_input', action_id: 'b', is_decimal_allowed: true } },
        { type: 'input', block_id: 'mail', label: text('Email'), element: { type: 'email_text_input', action_id: 'e' } },
        { type: 'input', block_id: 'link', label: text('Link'), element: { type: 'url_text_input', action_id: 'u', initial_value: 'https://example.com' } },
        { type: 'input', block_id: 'at', label: text('Start'), element: { type: 'timepicker', action_id: 't', initial_time: '09:00' } },
        { type: 'input', block_id: 'tags', label: text('Tags'), element: { type: 'multi_static_select', action_id: 'm', options: [opt('x', 'Urgent'), opt('y', 'Later')] } },
        { type: 'input', block_id: 'boxes', label: text('Needs'), element: { type: 'checkboxes', action_id: 'c', options: [opt('tv', 'Screen'), opt('cof', 'Coffee')] } },
        { type: 'input', block_id: 'size', label: text('Size'), element: { type: 'radio_buttons', action_id: 'r', options: [opt('s', 'Small'), opt('l', 'Large')] } },
        { type: 'input', block_id: 'host', label: text('Host'), element: { type: 'users_select', action_id: 'h', initial_user: 'u-bob' } },
        { type: 'input', block_id: 'guestlist', label: text('Guest list'), optional: true, element: { type: 'multi_users_select', action_id: 'g', max_selected_items: 2 } },
      ] as ViewBlock[],
    });
    const people = [
      { id: 'u-bob', displayName: 'Bob', email: 'bob@example.com' },
      { id: 'u-carol', displayName: 'Carol', email: 'carol@example.com' },
    ];

    it('fills in each with its own control, checks it, and sends lists as lists', async () => {
      const user = userEvent.setup();
      routes['POST /api/v1/users/batch'] = (body) => people.filter((p) => (body as { ids: string[] }).ids.includes(p.id));
      routes['GET /api/v1/users?q=ca'] = () => people;
      routes['POST /api/v1/views/V7/submit'] = (): ViewSubmitResult => ({ action: 'close' });
      await openForm(kinds);
      const f = (id: string) => fieldOf(id, 'V7');

      expect(f('guests')).toHaveAttribute('inputmode', 'numeric');
      expect(f('guests')).toHaveAttribute('placeholder', 'How many');
      expect(f('budget')).toHaveAttribute('inputmode', 'decimal');
      expect(f('mail')).toHaveAttribute('type', 'email');
      expect(f('link')).toHaveAttribute('type', 'url');
      expect(f('link')).toHaveValue('https://example.com');
      expect(f('at')).toHaveValue('09:00');
      expect(await within(screen.getByTestId('view-field-host')).findByText('Bob')).toBeInTheDocument();

      // Nothing is sent while fields need fixing.
      fireEvent.change(f('guests'), { target: { value: '0' } });
      fireEvent.change(f('mail'), { target: { value: 'not-an-address' } });
      fireEvent.click(screen.getByTestId('app-view-submit'));
      expect(noteOf('guests', 'V7')).toHaveTextContent('Use at least 1.');
      expect(noteOf('mail', 'V7')).toHaveTextContent('Enter an email address like name@example.com.');
      expect(noteOf('tags', 'V7')).toHaveTextContent('Please choose at least one.');
      expect(f('tags')).toHaveAttribute('aria-invalid', 'true');
      expect(noteOf('boxes', 'V7')).toHaveTextContent('Please choose at least one.');
      expect(noteOf('size', 'V7')).toHaveTextContent('Please choose one.');
      expect(submitCalls()).toHaveLength(0);

      fireEvent.change(f('guests'), { target: { value: '12' } });
      fireEvent.change(f('budget'), { target: { value: '99.50' } });
      fireEvent.change(f('mail'), { target: { value: 'team@example.com' } });
      fireEvent.change(f('at'), { target: { value: '10:30' } });

      await user.click(f('tags'));
      await user.click(await screen.findByRole('option', { name: 'Urgent' }));
      await user.click(screen.getByRole('option', { name: 'Later' }));
      await user.keyboard('{Escape}');
      await waitFor(() => expect(f('tags')).toHaveTextContent('UrgentLater'));
      expect(noteOf('tags', 'V7')).toBeNull();

      await user.click(screen.getByLabelText('Coffee'));
      await user.click(screen.getByLabelText('Screen'));
      await user.click(screen.getByLabelText('Large'));

      // One host: the chip replaces the search; removing it brings the search back.
      await user.click(screen.getByRole('button', { name: 'Remove Bob' }));
      const hostSearch = await screen.findByRole('combobox', { name: 'Host' });
      await user.type(hostSearch, 'ca');
      await user.click(await screen.findByRole('option', { name: /Carol/ }));
      expect(await within(screen.getByTestId('view-field-host')).findByText('Carol')).toBeInTheDocument();

      const guests = screen.getByRole('combobox', { name: 'Guest list' });
      await user.type(guests, 'ca');
      await user.click(await screen.findByRole('option', { name: /Bob/ }));
      expect(await within(screen.getByTestId('view-field-guestlist')).findByText('Bob')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('app-view-submit'));
      // The confirmation names options by their text and people by their names.
      await sentPanel();
      await waitFor(() =>
        expect(answersShown()).toEqual([
          ['Guests', '12'],
          ['Budget', '99.50'],
          ['Email', 'team@example.com'],
          ['Link', 'https://example.com'],
          ['Start', '10:30'],
          ['Tags', 'Urgent, Later'],
          ['Needs', 'Coffee, Screen'],
          ['Size', 'Large'],
          ['Host', 'Carol'],
          ['Guest list', 'Bob'],
        ]),
      );
      expect(sentValues()).toEqual({
        guests: { n: '12' },
        budget: { b: '99.50' },
        mail: { e: 'team@example.com' },
        link: { u: 'https://example.com' },
        at: { t: '10:30' },
        tags: { m: ['x', 'y'] },
        boxes: { c: ['cof', 'tv'] },
        size: { r: 'l' },
        host: { h: 'u-carol' },
        guestlist: { g: ['u-bob'] },
      });
    });
  });

  describe('the card it was opened from', () => {
    const cardMessage = (over: Partial<Message> = {}): Message =>
      ({
        id: 'm1',
        parentID: 'ch-1',
        authorID: 'webhook',
        body: 'A3 is due Fri',
        createdAt: '2026-10-30T10:00:00Z',
        appButtons: true,
        blocks: [{ type: 'actions', block_id: 'row', elements: [{ type: 'button', action_id: 'reschedule', text: text('Reschedule') }] }],
        ...over,
      }) as Message;
    const line = () => screen.queryByTestId('action-receipt');

    // renderCard draws the card and the form host, as the chat does. A click
    // on the card opens the form (the app's views.open, arriving over the
    // socket before the click's own answer); release answers the click.
    function renderCard(view: AppView = formView()) {
      let release: () => void = () => {};
      routes['POST /api/v1/channels/ch-1/messages/m1/actions'] = (body) => {
        act(() => openAppView({ view, app, clickID: (body as { clickID: string }).clickID }));
        return new Promise((resolve) => (release = () => resolve({ message: cardMessage({ version: 1 }), notice: 'Opening the form' })));
      };
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <MessageBlockScope message={cardMessage()} parentType="channel" parentID="ch-1" interactive currentUserId="u-alice">
            {(current) => <BlockList blocks={current.blocks} />}
          </MessageBlockScope>
          <AppViewHost />
        </QueryClientProvider>,
      );
      return { answerClick: () => act(async () => release()) };
    }

    it('follows the form: opened, then sent with what the app said — and shows again what was sent', async () => {
      routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'close', notice: 'Moved to Mon 2 Nov' });
      const { answerClick } = renderCard();
      fireEvent.click(screen.getByTestId('block-button-reschedule'));
      await screen.findByTestId('app-view-dialog');
      await waitFor(() => expect(line()?.textContent).toMatch(/^You opened “Reschedule A3” · \d{1,2}:\d{2}/));
      // The click's own answer, arriving later, doesn't take that back.
      await answerClick();
      expect(mockToast).toHaveBeenCalledWith('Opening the form', 'success');
      expect(line()!.textContent).toMatch(/^You opened “Reschedule A3” · [^—]*$/);

      type('reason', 'Out sick');
      fireEvent.change(fieldOf('room'), { target: { value: 'b' } });
      fireEvent.click(screen.getByTestId('app-view-submit'));
      await sentPanel();
      expect(line()!.textContent).toMatch(/^You sent “Reschedule A3” · .* — Moved to Mon 2 Nov · View details$/);
      expect(useActionReceipts.getState().byMessage.m1.details).toEqual({
        app: 'MeetingMind',
        title: 'Reschedule A3',
        notice: 'Moved to Mon 2 Nov',
        answers: [
          { label: 'Reason', text: 'Out sick' },
          { label: 'New date', text: 'Mon, Nov 2, 2026' },
          { label: 'Room', text: 'Room B' },
        ],
      });
      fireEvent.click(screen.getByTestId('app-view-done'));
      await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
      // Done changes nothing on the line.
      expect(line()).toHaveTextContent('You sent “Reschedule A3”');

      // Later, from the line: what was sent, again.
      fireEvent.click(screen.getByTestId('action-receipt-details'));
      const details = await screen.findByTestId('sent-details-dialog');
      expect(within(details).getByRole('heading', { name: 'Reschedule A3' })).toBeInTheDocument();
      expect(within(details).getByText('Moved to Mon 2 Nov')).toBeInTheDocument();
      expect(answersShown()).toEqual([
        ['Reason', 'Out sick'],
        ['New date', 'Mon, Nov 2, 2026'],
        ['Room', 'Room B'],
      ]);
      fireEvent.click(details.querySelector<HTMLButtonElement>('[data-slot="dialog-footer"] button')!);
      await waitFor(() => expect(screen.queryByTestId('sent-details-dialog')).toBeNull());
    });

    it('says the form was closed without sending', async () => {
      routes['POST /api/v1/views/V1/close'] = () => ({});
      const { answerClick } = renderCard();
      fireEvent.click(screen.getByTestId('block-button-reschedule'));
      await screen.findByTestId('app-view-dialog');
      await answerClick();
      fireEvent.click(screen.getByTestId('app-view-close'));
      await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
      expect(line()!.textContent).toMatch(/^You closed “Reschedule A3” without sending · /);
      expect(screen.queryByTestId('action-receipt-details')).toBeNull();
      expect(closeBody()).toMatchObject({ all: true });
    });

    it("keeps the first form's line while the app reshapes it or pushes another on top", async () => {
      const step2 = formView({ id: 'V2', hash: 's2', title: text('Pick a time'), previous_view_id: 'V1', blocks: [] });
      routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'push', view: step2 });
      const { answerClick } = renderCard();
      fireEvent.click(screen.getByTestId('block-button-reschedule'));
      await screen.findByTestId('app-view-dialog');
      await answerClick();
      await waitFor(() => expect(line()).toHaveTextContent('You opened “Reschedule A3”'));
      const opened = useActionReceipts.getState().byMessage.m1;

      // A live change to the form (a new title) doesn't note it again.
      act(() => updateAppView({ view: formView({ title: text('Reschedule A3 (2 left)'), hash: 'h2' }), app }));
      await screen.findByRole('heading', { name: 'Reschedule A3 (2 left)' });
      type('reason', 'Out sick');
      fireEvent.change(fieldOf('room'), { target: { value: 'b' } });
      fireEvent.click(screen.getByTestId('app-view-submit'));
      await screen.findByRole('heading', { name: 'Pick a time' });
      // Nor does the form pushed on top.
      expect(useActionReceipts.getState().byMessage.m1).toBe(opened);
    });

    it('names the first form on the card through a stack: Back, a cleared finish, a closed step', async () => {
      const step2 = formView({ id: 'V2', hash: 's2', title: text('Pick a time'), previous_view_id: 'V1', blocks: [] });
      routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'push', view: step2 });
      routes['POST /api/v1/views/V2/close'] = () => ({});
      const { answerClick } = renderCard();
      fireEvent.click(screen.getByTestId('block-button-reschedule'));
      await screen.findByTestId('app-view-dialog');
      await answerClick();
      await waitFor(() => expect(line()).toHaveTextContent('You opened “Reschedule A3”'));
      const opened = useActionReceipts.getState().byMessage.m1;
      const pushStep = async () => {
        type('reason', 'Out sick');
        fireEvent.change(fieldOf('room'), { target: { value: 'b' } });
        fireEvent.click(screen.getByTestId('app-view-submit'));
        await screen.findByRole('heading', { name: 'Pick a time' });
      };

      // Back to the first form isn't opening it again.
      await pushStep();
      fireEvent.click(screen.getByTestId('app-view-back'));
      await screen.findByRole('heading', { name: 'Reschedule A3' });
      expect(useActionReceipts.getState().byMessage.m1).toBe(opened);

      // Closing the pushed step closes the whole stack, and the card says
      // so by the first form's name.
      await pushStep();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('app-view-dialog')).toBeNull());
      expect(line()!.textContent).toMatch(/^You closed “Reschedule A3” without sending · /);
    });

    it('finishes a stack from its pushed step with no way back, named by the first form', async () => {
      const step2 = formView({ id: 'V2', hash: 's2', title: text('Pick a time'), previous_view_id: 'V1', blocks: [] });
      routes['POST /api/v1/views/V1/submit'] = (): ViewSubmitResult => ({ action: 'push', view: step2 });
      routes['POST /api/v1/views/V2/submit'] = (): ViewSubmitResult => ({ action: 'close', cleared: true, notice: 'Booked' });
      const { answerClick } = renderCard();
      fireEvent.click(screen.getByTestId('block-button-reschedule'));
      await screen.findByTestId('app-view-dialog');
      await answerClick();
      type('reason', 'Out sick');
      fireEvent.change(fieldOf('room'), { target: { value: 'b' } });
      fireEvent.click(screen.getByTestId('app-view-submit'));
      await screen.findByRole('heading', { name: 'Pick a time' });
      expect(screen.getByTestId('app-view-back')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('app-view-submit'));
      await sentPanel();
      // Sent is done: no step to go back to.
      expect(screen.queryByTestId('app-view-back')).toBeNull();
      expect(line()!.textContent).toMatch(/^You sent “Reschedule A3” · .* — Booked · View details$/);
    });
  });
});
