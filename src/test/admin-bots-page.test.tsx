import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn(async () => {}) }));
vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({ map: new Map([['u-admin', { id: 'u-admin', displayName: 'Ada Admin' }]]) }),
}));

// A stand-in for the confirm dialog: it renders while open, and keeps each
// dialog's props (by its confirm label) so the arms the real dialog never
// fires can be reached.
type ConfirmProps = { open: boolean; title: string; confirmLabel: string; onOpenChange: (o: boolean) => void; onConfirm: () => void };
const confirmProps = vi.hoisted(() => ({ byLabel: {} as Record<string, ConfirmProps> }));
vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: ConfirmProps) => {
    confirmProps.byLabel[props.confirmLabel] = props;
    if (!props.open) return null;
    return (
      <div role="dialog" aria-label={props.title}>
        <button onClick={props.onConfirm}>{props.confirmLabel}</button>
        <button onClick={() => props.onOpenChange(false)}>Cancel</button>
      </div>
    );
  },
}));

import AdminBotsPage from '@/pages/AdminBotsPage';

type Init = { method?: string; body?: string };

const BOTS = [
  { id: 'b-1', username: 'incident-bot', displayName: 'Incident Bot', description: 'Opens incident channels', ownerID: 'u-admin', status: 'active', createdAt: '', updatedAt: '' },
  // Migrated from Mattermost: no username, description or owner.
  { id: 'b-2', username: '', displayName: 'Alerts', description: '', ownerID: '', status: 'active', createdAt: '', updatedAt: '' },
  { id: 'b-3', username: 'general-bot', displayName: 'General Bot', description: '', ownerID: 'u-gone', status: 'deactivated', createdAt: '', updatedAt: '' },
];

const TOKENS = [{ id: 't-1', botUserID: 'b-1', description: 'CliffHub', createdBy: 'u-admin', createdAt: '2026-11-01T10:00:00Z' }];

function routeApi(overrides: Record<string, (init?: Init) => Promise<unknown>> = {}) {
  mockApiFetch.mockImplementation((path: string, init?: Init) => {
    const key = `${init?.method ?? 'GET'} ${path}`;
    if (overrides[key]) return overrides[key](init);
    if (key === 'GET /api/v1/admin/bots') return Promise.resolve(BOTS);
    if (key === 'GET /api/v1/admin/bots/b-1/tokens') return Promise.resolve(TOKENS);
    return Promise.resolve({});
  });
}

function calls(key: string) {
  return mockApiFetch.mock.calls.filter(([path, init]) => `${(init as Init | undefined)?.method ?? 'GET'} ${path}` === key);
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AdminBotsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const card = (id: string) => screen.getByTestId(`bot-${id}`);
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
  mockApiFetch.mockReset();
  confirmProps.byLabel = {};
});

describe('AdminBotsPage', () => {
  it('lists the bots by name, migrated ones too, with what is known about each', async () => {
    routeApi();
    renderPage();
    expect(screen.getByRole('heading', { name: 'Bots' })).toBeInTheDocument();
    await screen.findByText('Incident Bot');
    const names = screen.getAllByTestId(/^bot-b-\d$/).map((el) => el.querySelector('p')?.textContent);
    expect(names).toEqual(['Alerts', 'General BotDisabled', 'Incident Bot']);

    expect(card('b-1')).toHaveTextContent('@incident-bot·Opens incident channels·Created by Ada Admin');
    // Nothing known beyond its name.
    expect(card('b-2').querySelectorAll('p')).toHaveLength(1);
    // Its creator is gone; it is disabled.
    expect(card('b-3')).toHaveTextContent('@general-bot');
    expect(card('b-3')).not.toHaveTextContent('Created by');
    expect(within(card('b-3')).getByText('Disabled')).toBeInTheDocument();
    expect(within(card('b-1')).queryByText('Disabled')).not.toBeInTheDocument();
  });

  it('shows no bots when the list answer is not a list', async () => {
    routeApi({ 'GET /api/v1/admin/bots': () => Promise.resolve({}) });
    renderPage();
    await waitFor(() => expect(calls('GET /api/v1/admin/bots')).toHaveLength(1));
    expect(screen.queryByTestId(/^bot-/)).not.toBeInTheDocument();
  });

  it('creates a bot from the form', async () => {
    let finish: (v: unknown) => void = () => {};
    routeApi({ 'POST /api/v1/admin/bots': () => new Promise((resolve) => (finish = resolve)) });
    renderPage();
    const create = screen.getByRole('button', { name: 'Create bot' });
    expect(create).toBeDisabled();
    fireEvent.change(input('Username'), { target: { value: ' pager-bot ' } });
    fireEvent.change(input('Display name'), { target: { value: ' Pager ' } });
    fireEvent.change(input('Description'), { target: { value: ' Pages on-call ' } });
    fireEvent.click(create);
    expect(await screen.findByRole('button', { name: 'Creating...' })).toBeDisabled();
    expect(JSON.parse(calls('POST /api/v1/admin/bots')[0][1].body)).toEqual({ username: 'pager-bot', displayName: 'Pager', description: 'Pages on-call' });
    finish({ id: 'b-9' });
    await waitFor(() => expect(input('Username').value).toBe(''));
    expect(screen.getByRole('button', { name: 'Create bot' })).toBeInTheDocument();
  });

  it('says why a bot could not be created', async () => {
    routeApi({ 'POST /api/v1/admin/bots': () => Promise.reject(new Error('that username is taken')) });
    renderPage();
    fireEvent.change(input('Username'), { target: { value: 'incident-bot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('that username is taken');
    // The form keeps what was typed.
    expect(input('Username').value).toBe('incident-bot');
  });

  it('edits a bot in its card, and cancels an edit', async () => {
    let finish: (v: unknown) => void = () => {};
    routeApi({ 'PATCH /api/v1/admin/bots/b-2': () => new Promise((resolve) => (finish = resolve)) });
    renderPage();
    await screen.findByText('Incident Bot');
    const usernames = () => screen.getAllByLabelText('Username').map((el) => (el as HTMLInputElement).value);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Incident Bot' }));
    const editing = within(card('b-1'));
    expect((editing.getByLabelText('Username') as HTMLInputElement).value).toBe('incident-bot');
    expect((editing.getByLabelText('Display name') as HTMLInputElement).value).toBe('Incident Bot');
    expect((editing.getByLabelText('Description') as HTMLInputElement).value).toBe('Opens incident channels');
    // The form for a new bot stays as it was.
    expect(usernames()).toEqual(['', 'incident-bot']);
    expect(screen.getByRole('button', { name: 'Create bot' })).toBeInTheDocument();
    fireEvent.click(editing.getByRole('button', { name: 'Cancel' }));
    expect(usernames()).toEqual(['']);
    expect(screen.getByRole('button', { name: 'Edit Incident Bot' })).toBeInTheDocument();

    // A migrated bot gets its username here.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Alerts' }));
    const alerts = within(card('b-2'));
    expect(alerts.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.change(alerts.getByLabelText('Username'), { target: { value: 'alerts' } });
    fireEvent.click(alerts.getByRole('button', { name: 'Save changes' }));
    expect(await alerts.findByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(alerts.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(JSON.parse(calls('PATCH /api/v1/admin/bots/b-2')[0][1].body)).toEqual({ username: 'alerts', displayName: 'Alerts', description: '' });
    finish({});
    await waitFor(() => expect(usernames()).toEqual(['']));
    expect(screen.getByRole('button', { name: 'Edit Alerts' })).toBeInTheDocument();
  });

  it('saves an edit to the bot being edited', async () => {
    routeApi();
    renderPage();
    await screen.findByText('Incident Bot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Incident Bot' }));
    const editing = within(card('b-1'));
    fireEvent.change(editing.getByLabelText('Display name'), { target: { value: 'Incidents' } });
    fireEvent.click(editing.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('PATCH /api/v1/admin/bots/b-1')).toHaveLength(1));
    expect(JSON.parse(calls('PATCH /api/v1/admin/bots/b-1')[0][1].body)).toEqual({
      username: 'incident-bot',
      displayName: 'Incidents',
      description: 'Opens incident channels',
    });
    await waitFor(() => expect(screen.getAllByLabelText('Username')).toHaveLength(1));
  });

  it('says in the card why an edit could not be saved, and keeps it open', async () => {
    routeApi({ 'PATCH /api/v1/admin/bots/b-1': () => Promise.reject(new Error('that username is taken')) });
    renderPage();
    await screen.findByText('Incident Bot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Incident Bot' }));
    const editing = within(card('b-1'));
    fireEvent.change(editing.getByLabelText('Username'), { target: { value: 'general-bot' } });
    fireEvent.click(editing.getByRole('button', { name: 'Save changes' }));
    expect(await editing.findByRole('alert')).toHaveTextContent('that username is taken');
    expect((editing.getByLabelText('Username') as HTMLInputElement).value).toBe('general-bot');
  });

  it('disables and enables bots, and says when that fails', async () => {
    routeApi({ 'POST /api/v1/admin/bots/b-3/enable': () => Promise.reject('offline') });
    renderPage();
    await screen.findByText('Incident Bot');
    fireEvent.click(screen.getByRole('button', { name: 'Disable Incident Bot' }));
    await waitFor(() => expect(calls('POST /api/v1/admin/bots/b-1/disable')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Enable General Bot' }));
    await waitFor(() => expect(calls('POST /api/v1/admin/bots/b-3/enable')).toHaveLength(1));
    // Not an Error: a generic line.
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed');
  });

  it('deletes a bot after asking', async () => {
    routeApi();
    renderPage();
    await screen.findByText('Incident Bot');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Incident Bot' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete "Incident Bot"?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls('DELETE /api/v1/admin/bots/b-1')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Incident Bot' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete bot' }));
    await waitFor(() => expect(calls('DELETE /api/v1/admin/bots/b-1')).toHaveLength(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The list is asked for again.
    await waitFor(() => expect(calls('GET /api/v1/admin/bots')).toHaveLength(2));

    // Confirming with nothing picked (the dialog closed meanwhile) deletes nothing.
    act(() => confirmProps.byLabel['Delete bot'].onConfirm());
    expect(calls('DELETE /api/v1/admin/bots/b-1')).toHaveLength(1);
  });

  it('says why a bot could not be deleted', async () => {
    routeApi({ 'DELETE /api/v1/admin/bots/b-1': () => Promise.reject(new Error('bot: no such bot')) });
    renderPage();
    await screen.findByText('Incident Bot');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Incident Bot' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete bot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bot: no such bot');
  });

  it("lists a bot's tokens, makes one and shows its secret once", async () => {
    routeApi({
      'POST /api/v1/admin/bots/b-1/tokens': () =>
        Promise.resolve({ token: { id: 't-2', botUserID: 'b-1', description: 'Staging', createdBy: 'u-admin', createdAt: '2026-11-05T10:00:00Z' }, secret: 'abcdefghijklmnopqrstuvwxyz' }),
    });
    renderPage();
    await screen.findByText('Incident Bot');
    const toggle = screen.getByRole('button', { name: 'Access tokens for Incident Bot' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByTestId('bot-token-t-1')).toHaveTextContent('CliffHub');

    const create = screen.getByRole('button', { name: 'Create token' });
    expect(create).toBeDisabled();
    fireEvent.change(input('Token description'), { target: { value: ' Staging ' } });
    fireEvent.click(create);
    expect(await screen.findByTestId('bot-token-secret')).toHaveTextContent('abcdefghijklmnopqrstuvwxyz');
    expect(JSON.parse(calls('POST /api/v1/admin/bots/b-1/tokens')[0][1].body)).toEqual({ description: 'Staging' });
    expect(input('Token description').value).toBe('');
    expect(screen.getByRole('button', { name: 'Copy token Staging' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('bot-token-secret')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId('bot-tokens-b-1')).not.toBeInTheDocument();
  });

  it('shows no tokens when the answer is not a list', async () => {
    routeApi({ 'GET /api/v1/admin/bots/b-1/tokens': () => Promise.resolve(null) });
    renderPage();
    await screen.findByText('Incident Bot');
    fireEvent.click(screen.getByRole('button', { name: 'Access tokens for Incident Bot' }));
    await waitFor(() => expect(calls('GET /api/v1/admin/bots/b-1/tokens')).toHaveLength(1));
    expect(screen.queryByTestId(/^bot-token-t-/)).not.toBeInTheDocument();
  });

  it('revokes a token after asking', async () => {
    routeApi();
    renderPage();
    await screen.findByText('Incident Bot');
    fireEvent.click(screen.getByRole('button', { name: 'Access tokens for Incident Bot' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke CliffHub' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke "CliffHub"?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls('DELETE /api/v1/admin/bots/b-1/tokens/t-1')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke CliffHub' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke token' }));
    await waitFor(() => expect(calls('DELETE /api/v1/admin/bots/b-1/tokens/t-1')).toHaveLength(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Confirming with nothing picked (the dialog closed meanwhile) revokes nothing.
    act(() => confirmProps.byLabel['Revoke token'].onConfirm());
    expect(calls('DELETE /api/v1/admin/bots/b-1/tokens/t-1')).toHaveLength(1);
  });

  it('says why a token could not be made or revoked', async () => {
    routeApi({
      'POST /api/v1/admin/bots/b-1/tokens': () => Promise.reject(new Error('token description must be 1 to 255 characters')),
      'DELETE /api/v1/admin/bots/b-1/tokens/t-1': () => Promise.reject(new Error('bot: no such token')),
    });
    renderPage();
    await screen.findByText('Incident Bot');
    fireEvent.click(screen.getByRole('button', { name: 'Access tokens for Incident Bot' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke CliffHub' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bot: no such token');

    fireEvent.change(input('Token description'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('token description must be 1 to 255 characters'));
  });
});
