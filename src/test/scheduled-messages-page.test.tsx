import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DraftsPage from '@/pages/DraftsPage';
import { apiFetch } from '@/lib/api';
import type { ScheduledMessage } from '@/types';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast: toast }));

const future = new Date(Date.now() + 2 * 24 * 3600e3).toISOString();
const list: ScheduledMessage[] = [
  { id: 's-1', userID: 'u-1', parentID: 'ch-1', parentType: 'channel', parentMessageID: 'root-1', body: 'Ship **it** at nine', attachmentIDs: ['a', 'b'], sendAt: future, state: 'pending', createdAt: '', updatedAt: '' },
  { id: 's-2', userID: 'u-1', parentID: 'dm-1', parentType: 'conversation', body: '', attachmentIDs: ['c'], sendAt: future, state: 'failed', failReason: 'You no longer have access to this conversation.', createdAt: '', updatedAt: '' },
  { id: 's-3', userID: 'u-1', parentID: 'ch-gone', parentType: 'channel', body: 'into the void', sendAt: future, state: 'pending', createdAt: '', updatedAt: '' },
  { id: 's-4', userID: 'u-1', parentID: 'dm-gone', parentType: 'conversation', body: 'hello?', sendAt: future, state: 'pending', createdAt: '', updatedAt: '' },
];

function mockApi(overrides: (path: string, method?: string) => unknown = () => undefined) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, options?: { method?: string }) => {
    const o = overrides(path, options?.method);
    if (o instanceof Error) throw o;
    if (o !== undefined) return o;
    if (path === '/api/v1/scheduled-messages' && !options?.method) return list;
    if (path === '/api/v1/channels') return [{ channelID: 'ch-1', channelName: 'Team Room', channelType: 'public', role: 1 }];
    if (path === '/api/v1/conversations') return [{ conversationID: 'dm-1', type: 'dm', displayName: 'Alice' }];
    if (path === '/api/v1/drafts') return [];
    return undefined;
  });
}

function renderPage(path = '/drafts?tab=scheduled') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <DraftsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const calls = (method: string) =>
  vi.mocked(apiFetch).mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === method).map(([p]) => p);

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  toast.mockReset();
});

describe('Drafts page — Scheduled tab', () => {
  it('switches between drafts and scheduled messages, counting the scheduled ones', async () => {
    mockApi();
    renderPage('/drafts');
    expect(await screen.findByText("Messages you started but haven't sent yet.")).toBeInTheDocument();
    const scheduledTab = screen.getByRole('tab', { name: /Scheduled/ });
    await waitFor(() => expect(scheduledTab).toHaveTextContent('Scheduled4'));
    fireEvent.click(scheduledTab);
    expect(await screen.findAllByTestId('scheduled-row')).toHaveLength(4);
    expect(screen.getByText('Messages set to send later.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Drafts' }));
    expect(await screen.findByTestId('drafts-empty')).toBeInTheDocument();
  });

  it('shows where each goes, when, its files, and why a failed one was not sent', async () => {
    mockApi();
    renderPage();
    const [pending, failed, unknownChannel, unknownDM] = await screen.findAllByTestId('scheduled-row');
    expect(pending).toHaveTextContent('~Team Room');
    expect(pending).toHaveTextContent('thread');
    expect(pending).toHaveTextContent('Ship **it** at nine');
    expect(pending).toHaveTextContent(/Sends .+ at /);
    expect(pending).toHaveTextContent('2');
    expect(within(pending).getByRole('link')).toHaveAttribute('href', '/channel/team-room?thread=root-1#msg-root-1');
    expect(failed).toHaveTextContent('Alice');
    expect(failed).toHaveTextContent('Attachment');
    expect(within(failed).getByTestId('scheduled-failed')).toHaveTextContent('Not sent: You no longer have access');
    expect(within(failed).getByRole('link')).toHaveAttribute('href', '/conversation/dm-1');
    expect(within(failed).getByLabelText('Try sending again')).toBeInTheDocument();
    expect(unknownChannel).toHaveTextContent('~channel');
    expect(within(unknownChannel).getByRole('link')).toHaveAttribute('href', '/channel/ch-gone');
    expect(unknownDM).toHaveTextContent('Conversation');
  });

  it('sends one now — and says so when it can\'t', async () => {
    mockApi();
    renderPage();
    const [pending, failed] = await screen.findAllByTestId('scheduled-row');
    fireEvent.click(within(pending).getByLabelText('Send now'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Sent', 'success'));
    expect(calls('POST')).toContain('/api/v1/scheduled-messages/s-1/send');

    mockApi((path, method) => (method === 'POST' ? new Error('busy') : undefined));
    fireEvent.click(within(pending).getByLabelText('Send now'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't send it right now — try again in a moment."));
    fireEvent.click(within(failed).getByLabelText('Try sending again'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Still couldn't send it."));
  });

  it('deletes one after confirming', async () => {
    mockApi();
    renderPage();
    const [pending] = await screen.findAllByTestId('scheduled-row');
    fireEvent.click(within(pending).getByLabelText('Delete scheduled message'));
    fireEvent.click(await screen.findByTestId('delete-scheduled-dialog-confirm'));
    await waitFor(() => expect(calls('DELETE')).toContain('/api/v1/scheduled-messages/s-1'));
  });

  it('edits the text and time, checking both first', async () => {
    mockApi();
    renderPage();
    const [pending, failed] = await screen.findAllByTestId('scheduled-row');
    fireEvent.click(within(pending).getByLabelText('Edit scheduled message'));
    const dialog = await screen.findByTestId('edit-scheduled-dialog');
    const text = within(dialog).getByLabelText('Message');
    const time = within(dialog).getByLabelText('Send time');
    fireEvent.change(time, { target: { value: '2000-01-01T09:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByTestId('edit-scheduled-error')).toHaveTextContent('Pick a time in the future.');
    fireEvent.change(time, { target: { value: '2099-03-04T09:30' } });
    fireEvent.change(text, { target: { value: '  ' } });
    // Files alone are a message, so emptying the text is fine here…
    mockApi((path, method) => (method === 'PATCH' ? new Error('nope') : undefined));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(within(dialog).getByTestId('edit-scheduled-error')).toHaveTextContent("Couldn't save"));
    let finishSave: (v: unknown) => void = () => {};
    mockApi((path, method) => (method === 'PATCH' ? new Promise((r) => (finishSave = r)) : undefined));
    fireEvent.change(text, { target: { value: 'Ship at ten' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    });
    expect(await within(dialog).findByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => finishSave({ ...list[0], body: 'Ship at ten' }));
    await waitFor(() => expect(screen.queryByTestId('edit-scheduled-dialog')).toBeNull());
    const patch = vi.mocked(apiFetch).mock.calls.filter(([, o]) => (o as { method?: string })?.method === 'PATCH').at(-1)!;
    expect(JSON.parse((patch[1] as { body: string }).body)).toEqual({ body: 'Ship at ten', sendAt: new Date('2099-03-04T09:30').toISOString() });

    // …but a message with no files needs text. Cancel closes without saving.
    const others = screen.getAllByTestId('scheduled-row');
    fireEvent.click(within(others[2]).getByLabelText('Edit scheduled message'));
    const d2 = await screen.findByTestId('edit-scheduled-dialog');
    fireEvent.change(within(d2).getByLabelText('Message'), { target: { value: ' ' } });
    fireEvent.click(within(d2).getByRole('button', { name: 'Save' }));
    expect(within(d2).getByTestId('edit-scheduled-error')).toHaveTextContent('The message is empty.');
    fireEvent.click(within(d2).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('edit-scheduled-dialog')).toBeNull());
    expect(failed).toBeInTheDocument();
  });

  it('shows a loading state, then an empty one', async () => {
    let resolve: (v: unknown) => void = () => {};
    mockApi((path, method) => (path === '/api/v1/scheduled-messages' && !method ? new Promise((r) => (resolve = r)) : undefined));
    renderPage();
    expect(screen.getByTestId('scheduled-loading')).toBeInTheDocument();
    await act(async () => resolve([]));
    expect(await screen.findByTestId('scheduled-empty')).toBeInTheDocument();
  });
});
