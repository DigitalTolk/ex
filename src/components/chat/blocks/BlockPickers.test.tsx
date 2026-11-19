import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Block, Message, PickerElement, SelectOption } from '@/types';
import { BlockList, MessageBlockScope } from './MessageBlocks';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
const mockToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));

const text = (t: string) => ({ type: 'plain_text' as const, text: t });
const opt = (value: string, label = value, over: Partial<SelectOption> = {}): SelectOption => ({ text: text(label), value, ...over });
const rooms = [opt('a', 'Room A'), opt('b', 'Room B')];

const people = [
  { id: 'u-bob', displayName: 'Bob', email: 'bob@example.com' },
  { id: 'u-bonnie', displayName: 'Bonnie', email: 'bonnie@example.com' },
];

function card(elements: PickerElement[], over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    parentID: 'ch-1',
    authorID: 'webhook',
    body: 'fallback',
    createdAt: '2026-10-30T10:00:00Z',
    appButtons: true,
    blocks: [{ type: 'actions', block_id: 'row', elements }] as Block[],
    ...over,
  } as Message;
}

function renderCard(message: Message, opts: { interactive?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MessageBlockScope message={message} parentType="channel" parentID="ch-1" interactive={opts.interactive ?? true} currentUserId="u-alice">
        {(current) => <BlockList blocks={current.blocks} />}
      </MessageBlockScope>
    </QueryClientProvider>,
  );
}

const actionCalls = () => mockApiFetch.mock.calls.filter(([path]) => String(path).endsWith('/messages/m1/actions'));
const sent = () => actionCalls().map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>);
const lastSent = () => sent().at(-1);
const el = (actionID: string) => screen.getByTestId(`msg-m1-row-${actionID}`);
// The line under the card: what the person picked, in words.
const said = async (text: string) => waitFor(() => expect(screen.getByTestId('action-receipt').textContent).toMatch(new RegExp(`^${text} · `)));

let release: (() => void) | null;

beforeEach(() => {
  release = null;
  mockToast.mockReset();
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
    if (path.startsWith('/api/v1/users?q=')) {
      const q = decodeURIComponent(path.split('q=')[1]).toLowerCase();
      return Promise.resolve(people.filter((p) => p.displayName.toLowerCase().startsWith(q)));
    }
    if (path === '/api/v1/users/batch') {
      const { ids } = JSON.parse(init!.body!) as { ids: string[] };
      return Promise.resolve(people.filter((p) => ids.includes(p.id)));
    }
    if (path.endsWith('/actions')) {
      const answer = { message: card([]) };
      if (release === null) return Promise.resolve(answer);
      return new Promise((resolve) => (release = () => resolve(answer)));
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

describe('pickers in a message', () => {
  it('picks a person: types part of a name, picks from the list, and sends their ID', async () => {
    const user = userEvent.setup();
    renderCard(card([{ type: 'users_select', action_id: 'owner', placeholder: text('Assign to') }]));
    const search = el('owner');
    expect(search).toHaveAttribute('placeholder', 'Assign to');
    expect(search).toHaveAccessibleName('Assign to');

    await user.type(search, 'bo');
    await user.click(await screen.findByRole('option', { name: /Bob/ }));

    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(lastSent()).toMatchObject({ blockID: 'row', actionID: 'owner', value: 'u-bob' });
    await said('You picked Bob');
    // The person picked shows as a chip in place of the search.
    expect(await within(screen.getByTestId('block-picker-owner')).findByText('Bob')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();

    // A message's person is only ever picked, never sent empty: removing the
    // chip sends nothing and keeps the pick.
    await user.click(screen.getByRole('button', { name: 'Remove Bob' }));
    expect(within(screen.getByTestId('block-picker-owner')).getByText('Bob')).toBeInTheDocument();
    expect(actionCalls()).toHaveLength(1);
  });

  it('starts at the person the app picked', async () => {
    renderCard(card([{ type: 'users_select', action_id: 'owner', initial_user: 'u-bonnie' }]));
    expect(await within(screen.getByTestId('block-picker-owner')).findByText('Bonnie')).toBeInTheDocument();
  });

  it('asks first when a pick needs confirming: cancel puts the old choice back, confirm sends', async () => {
    renderCard(
      card([
        {
          type: 'static_select',
          action_id: 'room',
          options: rooms,
          initial_option: rooms[0],
          confirm: { title: text('Move the meeting?'), text: text('Everyone is told.'), confirm: text('Move it'), deny: text('Keep it') },
        },
      ]),
    );
    const select = el('room') as HTMLSelectElement;
    expect(select.value).toBe('a');

    fireEvent.change(select, { target: { value: 'b' } });
    const dialog = await screen.findByTestId('block-confirm');
    expect(within(dialog).getByText('Move the meeting?')).toBeInTheDocument();
    expect(within(dialog).getByText('Everyone is told.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText('Keep it'));
    await waitFor(() => expect(screen.queryByTestId('block-confirm')).toBeNull());
    expect(select.value).toBe('a');
    expect(actionCalls()).toHaveLength(0);

    fireEvent.change(select, { target: { value: 'b' } });
    fireEvent.click(within(await screen.findByTestId('block-confirm')).getByText('Move it'));
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(lastSent()).toMatchObject({ blockID: 'row', actionID: 'room', value: 'b' });
    await said('You chose “Room B”');
    // The confirmed choice stays picked.
    await waitFor(() => expect(screen.queryByTestId('block-confirm')).toBeNull());
    expect(select.value).toBe('b');
  });

  it('sends a select at once without a confirm, and shows it is sending', async () => {
    release = () => {};
    renderCard(card([{ type: 'static_select', action_id: 'room', options: rooms }]));
    const select = el('room') as HTMLSelectElement;
    // No choice yet: the app's placeholder, or ex's.
    expect(select.value).toBe('');
    expect(select.options[0]).toHaveTextContent('Choose…');
    expect(select).toHaveAccessibleName('Choose');
    expect(select.parentElement!.className).toContain('[&_select]:text-muted-foreground');

    fireEvent.change(select, { target: { value: 'b' } });
    const wrap = screen.getByTestId('block-picker-room');
    await waitFor(() => expect(wrap).toHaveAttribute('aria-busy', 'true'));
    expect(within(wrap).getByLabelText('Sending')).toBeInTheDocument();
    expect(select).toBeDisabled();

    await act(async () => release!());
    await waitFor(() => expect(wrap).not.toHaveAttribute('aria-busy'));
    expect(select).not.toBeDisabled();
    expect(select.value).toBe('b');
    expect(lastSent()).toMatchObject({ actionID: 'room', value: 'b' });
    await said('You chose “Room B”');
  });

  it("opens a ⋯ menu: a link option is a link, any other sends its value", async () => {
    const user = userEvent.setup();
    renderCard(
      card([
        {
          type: 'overflow',
          action_id: 'more',
          options: [opt('receipt', 'View the receipt', { url: 'https://example.com/r/42' }), opt('later', 'Remind me later')],
        },
      ]),
    );
    await user.click(screen.getByRole('button', { name: 'More options' }));
    const link = await screen.findByRole('menuitem', { name: 'View the receipt' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://example.com/r/42');
    expect(link).toHaveAttribute('target', '_blank');
    await user.click(screen.getByRole('menuitem', { name: 'Remind me later' }));
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(lastSent()).toMatchObject({ actionID: 'more', value: 'later' });
    await said('You chose “Remind me later”');
  });

  it('sends the whole list of checked boxes on each toggle', async () => {
    const user = userEvent.setup();
    renderCard(
      card([
        {
          type: 'checkboxes',
          action_id: 'done',
          options: [opt('a', 'Tests', { description: text('Unit and browser') }), opt('b', 'Docs'), opt('c', '**Review**')],
          initial_options: [opt('a', 'Tests')],
        },
      ]),
    );
    const group = screen.getByRole('group', { name: 'Choose' });
    expect(within(group).getByLabelText(/Tests/)).toBeChecked();
    expect(within(group).getByText('Unit and browser')).toBeInTheDocument();

    await user.click(within(group).getByLabelText('Docs'));
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(lastSent()).toMatchObject({ actionID: 'done', value: ['a', 'b'] });
    await said('You chose “Tests”, “Docs”');

    await user.click(within(group).getByLabelText(/Tests/));
    await waitFor(() => expect(actionCalls()).toHaveLength(2));
    expect(lastSent()).toMatchObject({ value: ['b'] });
    await said('You chose “Docs”');

    await user.click(within(group).getByLabelText('Docs'));
    await waitFor(() => expect(actionCalls()).toHaveLength(3));
    expect(lastSent()).toMatchObject({ value: [] });
    await said('You cleared your choices');
  });

  it('names a box the app checked but no longer lists by its value', async () => {
    const user = userEvent.setup();
    renderCard(card([{ type: 'checkboxes', action_id: 'done', options: [opt('b', 'Docs')], initial_options: [opt('gone', 'Gone')] }]));
    await user.click(screen.getByLabelText('Docs'));
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(lastSent()).toMatchObject({ value: ['gone', 'b'] });
    await said('You chose “gone”, “Docs”');
  });

  it('sends the one radio button picked', async () => {
    const user = userEvent.setup();
    renderCard(card([{ type: 'radio_buttons', action_id: 'size', options: [opt('s', 'Small'), opt('l', 'Large')], initial_option: opt('s', 'Small') }]));
    const group = screen.getByRole('radiogroup');
    expect(within(group).getByLabelText('Small')).toBeChecked();
    await user.click(within(group).getByLabelText('Large'));
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(lastSent()).toMatchObject({ actionID: 'size', value: 'l' });
    await said('You chose “Large”');
  });

  it('applies a multi-select once, sending every option chosen', async () => {
    const user = userEvent.setup();
    renderCard(
      card([
        {
          type: 'multi_static_select',
          action_id: 'tags',
          placeholder: text('Tags'),
          options: [opt('x', 'Urgent'), opt('y', 'Later'), opt('z', 'Maybe')],
          initial_options: [opt('x', 'Urgent')],
        },
      ]),
    );
    const trigger = el('tags');
    expect(trigger).toHaveTextContent('Urgent');
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'Later' }));
    // Nothing is sent per toggle.
    expect(actionCalls()).toHaveLength(0);
    await user.click(screen.getByTestId('msg-m1-row-tags-apply'));
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(lastSent()).toMatchObject({ actionID: 'tags', value: ['x', 'y'] });
    await said('You chose “Urgent”, “Later”');
    await waitFor(() => expect(trigger).toHaveTextContent('UrgentLater'));
  });

  it('sends a day picked on the calendar', async () => {
    renderCard(card([{ type: 'datepicker', action_id: 'due', initial_date: '2026-11-02', placeholder: text('Due') }]));
    const trigger = screen.getByTestId('msg-m1-row-due-trigger');
    expect(trigger).toHaveAccessibleName('Due');
    fireEvent.click(trigger);
    await screen.findByTestId('msg-m1-row-due-calendar');
    fireEvent.click(document.querySelector(`button[data-day="${new Date(2026, 10, 18).toLocaleDateString()}"]`)!);
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(lastSent()).toMatchObject({ actionID: 'due', value: '2026-11-18' });
    await said('You picked Wed, Nov 18, 2026');
  });

  it('sends a time once it is complete: on leaving the field or Enter, never while typing', async () => {
    renderCard(card([{ type: 'timepicker', action_id: 'at', initial_time: '09:00' }]));
    const field = el('at') as HTMLInputElement;
    expect(field).toHaveValue('09:00');

    fireEvent.change(field, { target: { value: '10:30' } });
    expect(actionCalls()).toHaveLength(0);
    fireEvent.blur(field);
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(lastSent()).toMatchObject({ actionID: 'at', value: '10:30' });
    await said('You picked 10:30');

    fireEvent.change(field, { target: { value: '11:15' } });
    fireEvent.keyDown(field, { key: 'Tab' });
    expect(actionCalls()).toHaveLength(1);
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(actionCalls()).toHaveLength(2));
    expect(lastSent()).toMatchObject({ value: '11:15' });
    await said('You picked 11:15');

    // A cleared time is not sent.
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(actionCalls()).toHaveLength(2);
  });

  it('starts every kind empty when the app gave no starting value', () => {
    renderCard(
      card([
        { type: 'multi_static_select', action_id: 'tags', options: rooms },
        { type: 'datepicker', action_id: 'due' },
        { type: 'timepicker', action_id: 'at' },
        { type: 'checkboxes', action_id: 'done', options: rooms },
        { type: 'radio_buttons', action_id: 'size', options: rooms },
        { type: 'users_select', action_id: 'owner' },
      ]),
    );
    expect(el('tags')).toHaveTextContent('Choose…');
    expect(screen.getByTestId('msg-m1-row-due-trigger')).toHaveTextContent('Pick a date');
    expect(el('at')).toHaveValue('');
    expect(screen.getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked)).toHaveLength(0);
    expect(screen.getAllByRole('radio').filter((c) => (c as HTMLInputElement).checked)).toHaveLength(0);
    expect(el('owner')).toHaveAttribute('placeholder', 'Search people');
  });

  it('keeps pickers disabled until the app is set up for them, or where the chat is read-only', () => {
    const elements: PickerElement[] = [
      { type: 'static_select', action_id: 'room', options: rooms },
      { type: 'checkboxes', action_id: 'done', options: rooms },
    ];
    const view = renderCard(card(elements, { appButtons: false }));
    expect(el('room')).toBeDisabled();
    expect(screen.getByTestId('block-picker-room')).toHaveAttribute('title', "This app isn't set up for buttons");
    view.unmount();

    const readOnly = renderCard(card(elements), { interactive: false });
    expect(el('room')).toBeDisabled();
    expect(screen.getAllByRole('checkbox').every((c) => (c as HTMLInputElement).disabled)).toBe(true);
    expect(screen.getByTestId('block-picker-room')).not.toHaveAttribute('title');
    readOnly.unmount();

    // A preview (no scope) shows them, not live.
    render(<BlockList blocks={card(elements).blocks} />);
    expect(screen.getByTestId('preview-row-room')).toBeDisabled();
    expect(screen.getByTestId('block-picker-room')).not.toHaveAttribute('title');
  });

  describe('the line under the card', () => {
    const priority: PickerElement = {
      type: 'static_select',
      action_id: 'priority',
      placeholder: text('Priority'),
      options: [opt('p1', 'P1'), opt('p2', 'P2')],
    };
    // The app's answer to a pick.
    const answerWith = (answer: () => Promise<unknown>) => {
      const serve = mockApiFetch.getMockImplementation()!;
      mockApiFetch.mockImplementation((path: string, init?: unknown) => (String(path).endsWith('/actions') ? answer() : serve(path, init)));
    };

    it("says what was picked and the app's answer: pick a priority, see it under the card", async () => {
      answerWith(() => Promise.resolve({ message: card([priority], { version: 1 }), notice: 'Priority set to P1' }));
      renderCard(card([priority]));
      fireEvent.change(el('priority'), { target: { value: 'p1' } });
      const line = await screen.findByTestId('action-receipt');
      expect(line.textContent).toMatch(/^You chose “P1” · \d{1,2}:\d{2}.* — Priority set to P1$/);
      expect(line.className).toContain('text-muted-foreground');
      expect(mockToast).toHaveBeenCalledWith('Priority set to P1', 'success');
    });

    it("shows a pick the app didn't take in red, with why", async () => {
      answerWith(() => Promise.resolve({ message: card([priority]), notice: "Triage didn't respond. Try again.", failed: true }));
      renderCard(card([priority]));
      fireEvent.change(el('priority'), { target: { value: 'p2' } });
      const line = await screen.findByTestId('action-receipt');
      expect(line.textContent).toMatch(/^You chose “P2” — didn't go through · .* — Triage didn't respond\. Try again\.$/);
      expect(line.className).toContain('text-destructive');

      // Nor one that never reached ex.
      answerWith(() => Promise.reject(new Error('this card changed, try again')));
      fireEvent.change(el('priority'), { target: { value: 'p1' } });
      await waitFor(() => expect(screen.getByTestId('action-receipt').textContent).toMatch(/^You chose “P1” — didn't go through · .* — this card changed, try again$/));
    });

    it('names the person picked once a confirm goes through', async () => {
      const user = userEvent.setup();
      renderCard(
        card([
          {
            type: 'users_select',
            action_id: 'owner',
            confirm: { title: text('Hand it over?'), text: text('They are told.'), confirm: text('Hand over'), deny: text('Keep it') },
          },
        ]),
      );
      await user.type(el('owner'), 'bo');
      await user.click(await screen.findByRole('option', { name: /Bonnie/ }));
      fireEvent.click(within(await screen.findByTestId('block-confirm')).getByText('Hand over'));
      await waitFor(() => expect(actionCalls()).toHaveLength(1));
      expect(lastSent()).toMatchObject({ actionID: 'owner', value: 'u-bonnie' });
      await said('You picked Bonnie');
    });
  });
});
