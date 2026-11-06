import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DraftsPage from '@/pages/DraftsPage';
import { apiFetch } from '@/lib/api';
import { wheelTo } from '@/test/wheel-time';
import type { Reminder, User } from '@/types';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast: toast }));
const me = vi.hoisted(() => ({ user: { id: 'u-1' } as { id: string } | null }));
vi.mock('@/context/AuthContext', () => ({ useOptionalAuth: () => ({ user: me.user }) }));

const future = new Date(Date.now() + 2 * 24 * 3600e3).toISOString();
const reminders: Reminder[] = [
  { id: 'r-1', userID: 'u-1', messageID: 'm-1', parentID: 'ch-1', parentType: 'channel', channelSlug: 'team-room', parentMessageID: 'root-1', messagePreview: 'Ship **it** at nine', userIDs: ['u-2', 'u-gone'], note: 'bring the Q3 numbers', remindAt: future, createdAt: '' },
  { id: 'r-2', userID: 'u-1', messageID: 'm-2', parentID: 'dm-1', parentType: 'conversation', remindAt: future, createdAt: '' },
  { id: 'r-3', userID: 'u-1', messageID: 'm-3', parentID: 'ch-gone', parentType: 'channel', channelSlug: 'old-room', messagePreview: 'hi', remindAt: future, createdAt: '' },
  { id: 'r-4', userID: 'u-1', messageID: 'm-4', parentID: 'ch-nameless', parentType: 'channel', messagePreview: 'hi', remindAt: future, createdAt: '' },
  { id: 'r-5', userID: 'u-1', messageID: 'm-5', parentID: 'dm-gone', parentType: 'conversation', messagePreview: 'hi', remindAt: future, createdAt: '' },
  { id: 'r-6', userID: 'u-1', messageID: 'm-6', parentID: 'ch-1', parentType: 'channel', channelSlug: 'team-room', messagePreview: 'standup moved', everyone: true, excludedUserIDs: ['u-2'], remindAt: future, createdAt: '' },
  { id: 'r-7', userID: 'u-1', messageID: 'm-7', parentID: 'dm-1', parentType: 'conversation', everyone: true, remindAt: future, createdAt: '' },
];
const users: User[] = [
  { id: 'u-1', email: '', displayName: 'Alice', systemRole: 'member', status: 'active' },
  { id: 'u-2', email: '', displayName: 'Bob', systemRole: 'member', status: 'active' },
  { id: 'u-3', email: '', displayName: 'Carol', systemRole: 'member', status: 'active' },
  { id: 'u-4', email: '', displayName: 'Cara', systemRole: 'member', status: 'active' },
  { id: 'bot-x', email: '', displayName: 'Carbot', systemRole: 'member', status: 'active', isBot: true },
  { id: 'a-1', email: '', displayName: 'Carl the agent', systemRole: 'member', status: 'active', kind: 'agent' },
];

// Everyone the users endpoint knows; a test of a big channel adds to it.
let directory: User[] = users;

function mockApi(overrides: (path: string, method?: string) => unknown = () => undefined) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
    const o = overrides(path, options?.method);
    if (o instanceof Error) throw o;
    if (o !== undefined) return o;
    if (path === '/api/v1/reminders' && !options?.method) return reminders;
    if (path === '/api/v1/channels') return [{ channelID: 'ch-1', channelName: 'Team Room', channelType: 'public', role: 1 }];
    if (path === '/api/v1/conversations') return [{ conversationID: 'dm-1', type: 'group', displayName: 'Bob, Cara' }];
    if (path === '/api/v1/channels/ch-1/members') {
      return ['u-1', 'u-2', 'u-3', 'bot-x', 'a-1'].map((id) => ({ channelID: 'ch-1', userID: id, role: 1, displayName: users.find((u) => u.id === id)!.displayName, joinedAt: '' }));
    }
    if (path === '/api/v1/conversations/dm-1') return { id: 'dm-1', type: 'group', participantIDs: ['u-1', 'u-2', 'u-4'] };
    if (path === '/api/v1/users/batch') {
      const { ids } = JSON.parse(options!.body!) as { ids: string[] };
      return directory.filter((u) => ids.includes(u.id));
    }
    return undefined;
  });
}

function renderPage(path = '/drafts?tab=reminders') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <DraftsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const lastBody = (method: string) => {
  const call = vi.mocked(apiFetch).mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === method).at(-1)!;
  return { path: call[0], body: JSON.parse((call[1] as { body: string }).body) as Record<string, unknown> };
};

async function openEditor(index: number) {
  const rows = await screen.findAllByTestId('reminder-row');
  fireEvent.click(within(rows[index]).getByLabelText('Edit reminder'));
  return screen.findByTestId('reminder-dialog');
}

// The Who list drops down over the dialog, outside it.
async function openWho(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByTestId('reminder-who'));
  return screen.findByTestId('reminder-people');
}

const search = (panel: HTMLElement, text: string) => fireEvent.change(within(panel).getByTestId('reminder-people-input'), { target: { value: text } });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  toast.mockReset();
  me.user = { id: 'u-1' };
  directory = users;
});

describe('Drafts page — Reminders tab', () => {
  it('opens from its tab, counting the reminders', async () => {
    mockApi();
    renderPage('/drafts');
    const tab = screen.getByRole('tab', { name: /Reminders/ });
    await waitFor(() => expect(tab).toHaveTextContent('Reminders7'));
    fireEvent.click(tab);
    expect(await screen.findAllByTestId('reminder-row')).toHaveLength(7);
    expect(screen.getByText(/the Reminder bot DMs you, or tags you and the people you added/)).toBeInTheDocument();
  });

  it('shows the message each is about, where, when and who else it tags', async () => {
    mockApi();
    renderPage();
    const [shared, dm, renamed, nameless, goneDM, everyoneBut, everyoneDM] = await screen.findAllByTestId('reminder-row');
    expect(shared).toHaveTextContent('~Team Room');
    expect(shared).toHaveTextContent('thread');
    expect(shared).toHaveTextContent('Ship **it** at nine');
    expect(await within(shared).findByTestId('reminder-row-people')).toHaveTextContent('With Bob, Someone');
    expect(within(shared).getByRole('link')).toHaveAttribute('href', '/channel/team-room?thread=root-1#msg-m-1');
    expect(within(shared).getByTestId('reminder-row-note')).toHaveTextContent('bring the Q3 numbers');
    expect(within(dm).queryByTestId('reminder-row-note')).toBeNull();
    expect(dm).toHaveTextContent('Bob, Cara');
    expect(dm).toHaveTextContent('A message');
    expect(within(dm).queryByTestId('reminder-row-people')).toBeNull();
    expect(within(dm).getByRole('link')).toHaveAttribute('href', '/conversation/dm-1#msg-m-2');
    // A channel no longer in the sidebar falls back to its slug, then to "channel".
    expect(renamed).toHaveTextContent('~old-room');
    expect(nameless).toHaveTextContent('~channel');
    expect(within(nameless).getByRole('link')).toHaveAttribute('href', '/channel/ch-nameless#msg-m-4');
    expect(goneDM).toHaveTextContent('Conversation');
    // For everyone: as such, naming whoever is left out.
    expect(await within(everyoneBut).findByTestId('reminder-row-people')).toHaveTextContent('Everyone except Bob');
    expect(within(everyoneDM).getByTestId('reminder-row-people')).toHaveTextContent(/^Everyone$/);
  });

  // Who is one line under the title; its list of the chat's people drops
  // down, a box each: ticked is reminded. "Everyone here" leaves people out by
  // unticking them.
  it('edits a reminder for everyone: untick to leave people out', async () => {
    mockApi();
    renderPage();
    const dialog = await openEditor(5);
    await waitFor(() => expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('Everyone except Bob'));
    const panel = await openWho(dialog);
    expect(within(panel).getByTestId('reminder-everyone')).toBeChecked();
    expect(panel).toHaveTextContent('5 people');
    // The chat's people — no bots or agents, no you — with Bob left out.
    const roster = within(panel).getByTestId('reminder-roster');
    await waitFor(() => expect(within(roster).getAllByRole('checkbox')).toHaveLength(2));
    expect(within(roster).getByLabelText('Remind Bob')).not.toBeChecked();
    expect(within(roster).getByLabelText('Remind Carol')).toBeChecked();
    // The search narrows the list.
    search(panel, 'car');
    expect(within(roster).getAllByRole('checkbox')).toHaveLength(1);
    search(panel, 'zzz');
    expect(within(panel).getByTestId('reminder-people-empty')).toHaveTextContent('No one here matches.');
    search(panel, '');
    fireEvent.click(within(roster).getByLabelText('Remind Carol'));
    expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('Everyone except Bob and Carol');
    fireEvent.click(within(roster).getByLabelText('Remind Bob'));
    expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('Everyone except Carol');
    // Closing it drops the search; the choice stays.
    search(panel, 'car');
    fireEvent.click(within(dialog).getByTestId('reminder-who'));
    await waitFor(() => expect(screen.queryByTestId('reminder-people')).toBeNull());
    expect(within(await openWho(dialog)).getByTestId('reminder-people-input')).toHaveValue('');
    // The preview says who, whatever the title.
    wheelTo(9, 30, (el, key) => fireEvent.keyDown(el, { key }));
    expect(within(dialog).getByTestId('reminder-preview')).toHaveTextContent(/^Reminds everyone /);
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('reminder-confirm'));
    });
    await waitFor(() => expect(screen.queryByTestId('reminder-dialog')).toBeNull());
    const { path, body } = lastBody('PATCH');
    expect(path).toBe('/api/v1/reminders/r-6');
    expect(body).toMatchObject({ everyone: true, excludedUserIDs: ['u-3'], userIDs: [] });
  });

  it("counts a conversation's participants, and turns a reminder for people into one for everyone and back", async () => {
    mockApi();
    renderPage();
    const dm = await openEditor(6);
    await waitFor(() => expect(within(dm).getByTestId('reminder-who-summary')).toHaveTextContent('Everyone here · 3 people'));
    fireEvent.click(within(dm).getByLabelText('Cancel'));
    await waitFor(() => expect(screen.queryByTestId('reminder-dialog')).toBeNull());

    const dialog = await openEditor(0);
    const panel = await openWho(dialog);
    const everyone = within(panel).getByTestId('reminder-everyone');
    expect(everyone).not.toBeChecked();
    fireEvent.click(everyone);
    expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('Everyone here · 5 people');
    // Off again starts from nobody else.
    fireEvent.click(everyone);
    expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('Just you');
    fireEvent.click(everyone);
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('reminder-confirm'));
    });
    await waitFor(() => expect(screen.queryByTestId('reminder-dialog')).toBeNull());
    expect(lastBody('PATCH').body).toMatchObject({ everyone: true, excludedUserIDs: [], userIDs: [] });
  });

  it("edits the time, the people and the note, offering only the channel's people", async () => {
    mockApi();
    renderPage();
    const dialog = await openEditor(0);
    expect(within(dialog).getByText('Edit reminder')).toBeInTheDocument();
    // Someone whose account is gone reads as "Someone".
    await waitFor(() => expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('You, Bob and Someone'));
    // The list waits for a tap; the time stays on screen beside it.
    expect(screen.queryByTestId('reminder-people')).toBeNull();
    const panel = await openWho(dialog);
    expect(within(dialog).getByTestId('reminder-wheel')).toBeInTheDocument();
    const roster = within(panel).getByTestId('reminder-roster');
    await waitFor(() => expect(within(roster).getAllByRole('checkbox')).toHaveLength(2));
    // You, bots and agents are never offered.
    expect(within(roster).queryByLabelText('Remind Alice')).toBeNull();
    expect(within(roster).queryByLabelText('Remind Carbot')).toBeNull();
    expect(within(roster).queryByLabelText('Remind Carl the agent')).toBeNull();
    expect(within(roster).getByLabelText('Remind Bob')).toBeChecked();
    fireEvent.click(within(roster).getByLabelText('Remind Carol'));
    expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('You, Bob, Someone and Carol');
    fireEvent.click(within(roster).getByLabelText('Remind Bob'));
    expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('You, Someone and Carol');

    // The note starts as it was, and is saved as edited.
    expect(within(dialog).getByTestId('reminder-note')).toHaveValue('bring the Q3 numbers');
    fireEvent.change(within(dialog).getByTestId('reminder-note'), { target: { value: ' bring the deck too ' } });

    wheelTo(9, 30, (el, key) => fireEvent.keyDown(el, { key }));
    expect(within(dialog).getByTestId('reminder-preview')).toHaveTextContent(/^Reminds you and 2 others /);
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('reminder-confirm'));
    });
    await waitFor(() => expect(screen.queryByTestId('reminder-dialog')).toBeNull());
    const { path, body } = lastBody('PATCH');
    expect(path).toBe('/api/v1/reminders/r-1');
    expect(body.userIDs).toEqual(['u-gone', 'u-3']);
    expect(body.note).toBe('bring the deck too');
    expect(new Date(body.remindAt as string).getHours()).toBe(9);
    expect(toast).toHaveBeenCalledWith('Reminder updated', 'success');
  });

  it("offers a conversation's participants by name", async () => {
    mockApi();
    renderPage();
    const dialog = await openEditor(1);
    expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('Just you');
    const panel = await openWho(dialog);
    fireEvent.click(await within(panel).findByLabelText('Remind Cara'));
    expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('You, Cara');
    wheelTo(9, 30, (el, key) => fireEvent.keyDown(el, { key }));
    expect(within(dialog).getByTestId('reminder-preview')).toHaveTextContent(/^Reminds you and 1 other /);
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('reminder-confirm'));
    });
    await waitFor(() => expect(lastBody('PATCH').body.userIDs).toEqual(['u-4']));
  });

  // A big channel: past the cap, only who's already picked can change.
  it('stops at the most people a reminder can add or leave out', async () => {
    const crowd: User[] = Array.from({ length: 22 }, (_, i) => ({ id: `p-${i}`, email: '', displayName: `Person ${String(i).padStart(2, '0')}`, systemRole: 'member', status: 'active' }));
    directory = [...users, ...crowd];
    mockApi((path) =>
      path === '/api/v1/channels/ch-1/members'
        ? ['u-1', ...crowd.map((u) => u.id)].map((id) => ({ channelID: 'ch-1', userID: id, role: 1, displayName: directory.find((u) => u.id === id)!.displayName, joinedAt: '' }))
        : undefined,
    );
    renderPage();
    const dialog = await openEditor(0);
    const panel = await openWho(dialog);
    const roster = within(panel).getByTestId('reminder-roster');
    await waitFor(() => expect(within(roster).getAllByRole('checkbox')).toHaveLength(22));
    for (let i = 0; i < 18; i++) fireEvent.click(within(roster).getByLabelText(`Remind Person ${String(i).padStart(2, '0')}`));
    expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('You, Bob, Someone and 18 others');
    expect(within(panel).getByTestId('reminder-people-full')).toHaveTextContent('Up to 20 people can be added.');
    expect(within(roster).getByLabelText('Remind Person 18')).toBeDisabled();
    expect(within(roster).getByLabelText('Remind Person 00')).toBeEnabled();
    // Everyone: twenty left out is as far as it goes.
    fireEvent.click(within(panel).getByTestId('reminder-everyone'));
    expect(within(panel).queryByTestId('reminder-people-full')).toBeNull();
    for (let i = 0; i < 20; i++) fireEvent.click(within(roster).getByLabelText(`Remind Person ${String(i).padStart(2, '0')}`));
    expect(within(panel).getByTestId('reminder-people-full')).toHaveTextContent('Up to 20 people can be left out.');
    expect(within(roster).getByLabelText('Remind Person 21')).toBeDisabled();
    expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent('Everyone except Person 00, Person 01 and 18 others');
  });

  it('says so while the chat and its people are still loading', async () => {
    mockApi((path) => (path === '/api/v1/conversations/dm-1' || path === '/api/v1/users/batch' ? new Promise(() => {}) : undefined));
    renderPage();
    const dialog = await openEditor(6);
    expect(within(dialog).getByTestId('reminder-who-summary')).toHaveTextContent(/^Everyone here$/);
    const panel = await openWho(dialog);
    expect(within(panel).getByTestId('reminder-people-empty')).toHaveTextContent('Loading people…');
    // No headcount until the conversation loads.
    expect(panel).not.toHaveTextContent(/\d people/);
  });

  it('keeps the dialog open with the error when saving fails', async () => {
    mockApi((path, method) => (method === 'PATCH' ? new Error('gone') : undefined));
    renderPage();
    const dialog = await openEditor(2);
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('reminder-confirm'));
    });
    expect(await within(dialog).findByTestId('reminder-error')).toHaveTextContent("Couldn't save the reminder");
    fireEvent.click(within(dialog).getByTestId('reminder-cancel'));
    await waitFor(() => expect(screen.queryByTestId('reminder-dialog')).toBeNull());
  });

  it('offers everyone in the chat before your own account has loaded', async () => {
    me.user = null;
    mockApi();
    renderPage();
    const dialog = await openEditor(0);
    const panel = await openWho(dialog);
    expect(await within(panel).findByLabelText('Remind Alice')).not.toBeChecked();
  });

  it('cancels one after confirming', async () => {
    mockApi();
    renderPage();
    const [shared] = await screen.findAllByTestId('reminder-row');
    fireEvent.click(within(shared).getByLabelText('Cancel reminder'));
    fireEvent.click(await screen.findByTestId('cancel-reminder-dialog-confirm'));
    await waitFor(() =>
      expect(vi.mocked(apiFetch).mock.calls.some(([p, o]) => p === '/api/v1/reminders/r-1' && (o as { method?: string })?.method === 'DELETE')).toBe(true),
    );
  });

  it('shows a loading state, then an empty one', async () => {
    let resolve: (v: unknown) => void = () => {};
    mockApi((path, method) => (path === '/api/v1/reminders' && !method ? new Promise((r) => (resolve = r)) : undefined));
    renderPage();
    expect(screen.getByTestId('reminders-loading')).toBeInTheDocument();
    await act(async () => resolve([]));
    expect(await screen.findByTestId('reminders-empty')).toBeInTheDocument();
  });
});
