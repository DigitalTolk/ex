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
];
const users: User[] = [
  { id: 'u-1', email: '', displayName: 'Alice', systemRole: 'member', status: 'active' },
  { id: 'u-2', email: '', displayName: 'Bob', systemRole: 'member', status: 'active' },
  { id: 'u-3', email: '', displayName: 'Carol', systemRole: 'member', status: 'active' },
  { id: 'u-4', email: '', displayName: 'Cara', systemRole: 'member', status: 'active' },
  { id: 'bot-x', email: '', displayName: 'Carbot', systemRole: 'member', status: 'active', isBot: true },
  { id: 'a-1', email: '', displayName: 'Carl the agent', systemRole: 'member', status: 'active', kind: 'agent' },
];

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
      return users.filter((u) => ids.includes(u.id));
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

const search = (dialog: HTMLElement, text: string) => fireEvent.change(within(dialog).getByTestId('reminder-people-input'), { target: { value: text } });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  toast.mockReset();
  me.user = { id: 'u-1' };
});

describe('Drafts page — Reminders tab', () => {
  it('opens from its tab, counting the reminders', async () => {
    mockApi();
    renderPage('/drafts');
    const tab = screen.getByRole('tab', { name: /Reminders/ });
    await waitFor(() => expect(tab).toHaveTextContent('Reminders5'));
    fireEvent.click(tab);
    expect(await screen.findAllByTestId('reminder-row')).toHaveLength(5);
    expect(screen.getByText(/the Reminder bot DMs you, or tags you and the people you added/)).toBeInTheDocument();
  });

  it('shows the message each is about, where, when and who else it tags', async () => {
    mockApi();
    renderPage();
    const [shared, dm, renamed, nameless, goneDM] = await screen.findAllByTestId('reminder-row');
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
  });

  it("edits the time, the people and the note, offering only the channel's people", async () => {
    mockApi();
    renderPage();
    const dialog = await openEditor(0);
    expect(within(dialog).getByText('Edit reminder')).toBeInTheDocument();
    expect(await within(dialog).findByTestId('reminder-person-u-2')).toHaveTextContent('Bob');

    // You, bots and agents are never offered; neither is anyone already on it.
    search(dialog, 'a');
    await within(dialog).findByTestId('reminder-people-option-u-3');
    expect(within(dialog).queryByTestId('reminder-people-option-u-1')).toBeNull();
    expect(within(dialog).queryByTestId('reminder-people-option-bot-x')).toBeNull();
    expect(within(dialog).queryByTestId('reminder-people-option-a-1')).toBeNull();
    search(dialog, 'bo');
    expect(await within(dialog).findByTestId('reminder-people-empty')).toHaveTextContent('No one in this conversation matches.');
    // Enter with nothing matching picks no one (and doesn't save either).
    fireEvent.keyDown(within(dialog).getByTestId('reminder-people-input'), { key: 'Enter' });
    expect(within(dialog).queryByTestId('reminder-person-u-3')).toBeNull();

    search(dialog, 'car');
    fireEvent.click(await within(dialog).findByTestId('reminder-people-option-u-3'));
    expect(within(dialog).getByTestId('reminder-person-u-3')).toHaveTextContent('Carol');
    expect(within(dialog).getByTestId('reminder-people-input')).toHaveValue('');
    fireEvent.click(within(dialog).getByLabelText('Remove Bob'));
    expect(within(dialog).queryByTestId('reminder-person-u-2')).toBeNull();
    // Someone whose account is gone reads as "Someone", to remove too.
    fireEvent.click(within(dialog).getByLabelText('Remove Someone'));

    // The note starts as it was, and is saved as edited.
    expect(within(dialog).getByTestId('reminder-note')).toHaveValue('bring the Q3 numbers');
    fireEvent.change(within(dialog).getByTestId('reminder-note'), { target: { value: ' bring the deck too ' } });

    wheelTo(9, 30, (el, key) => fireEvent.keyDown(el, { key }));
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('reminder-confirm'));
    });
    await waitFor(() => expect(screen.queryByTestId('reminder-dialog')).toBeNull());
    const { path, body } = lastBody('PATCH');
    expect(path).toBe('/api/v1/reminders/r-1');
    expect(body.userIDs).toEqual(['u-3']);
    expect(body.note).toBe('bring the deck too');
    expect(new Date(body.remindAt as string).getHours()).toBe(9);
    expect(toast).toHaveBeenCalledWith('Reminder updated', 'success');
  });

  it("offers a conversation's participants, picking the top match with Enter", async () => {
    mockApi();
    renderPage();
    const dialog = await openEditor(1);
    search(dialog, 'ca');
    await within(dialog).findByTestId('reminder-people-option-u-4');
    fireEvent.keyDown(within(dialog).getByTestId('reminder-people-input'), { key: 'Enter' });
    expect(within(dialog).getByTestId('reminder-person-u-4')).toHaveTextContent('Cara');
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('reminder-confirm'));
    });
    await waitFor(() => expect(lastBody('PATCH').body.userIDs).toEqual(['u-4']));
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
    search(dialog, 'ali');
    expect(await within(dialog).findByTestId('reminder-people-option-u-1')).toHaveTextContent('Alice');
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
