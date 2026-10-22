import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConvertToChannelDialog } from './ConvertToChannelDialog';
import { queryKeys } from '@/lib/query-keys';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile }));

import { ApiError } from '@/lib/api';

function renderDialog(onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(queryKeys.userConversations(), [
    { conversationID: 'g-1', type: 'group', displayName: 'Alice, Bob' },
    { conversationID: 'dm-1', type: 'dm', displayName: 'Carol' },
  ]);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/conversation/g-1']}>
        <Routes>
          <Route path="/conversation/:id" element={<ConvertToChannelDialog conversationID="g-1" open onOpenChange={onOpenChange} />} />
          <Route path="/channel/:id" element={<p data-testid="channel-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, onOpenChange };
}

describe('ConvertToChannelDialog', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    mockIsMobile = false;
  });

  it('makes the group a private channel and opens it', async () => {
    apiFetchMock.mockResolvedValue({ id: 'g-1', slug: 'ops', name: 'ops', type: 'private' });
    const user = userEvent.setup();
    const { qc, onOpenChange } = renderDialog();
    expect(screen.getByRole('button', { name: 'Convert' })).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'Ops Team');
    await user.click(screen.getByRole('button', { name: 'Convert' }));
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/conversations/g-1/convert', { method: 'POST', body: JSON.stringify({ name: 'ops-team' }) });
    expect(await screen.findByTestId('channel-page')).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Off the direct messages at once.
    expect((qc.getQueryData(queryKeys.userConversations()) as { conversationID: string }[]).map((c) => c.conversationID)).toEqual(['dm-1']);
  });

  it('says when the name is taken', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(409, 'channel: a channel with this name already exists'));
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Name'), 'ops');
    await user.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByTestId('channel-name-help')).toHaveTextContent('~ops already exists');
    expect(screen.getByRole('button', { name: 'Convert' })).toBeDisabled();
  });

  it('shows any other failure', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(409, 'channel: this conversation is a channel already'));
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Name'), 'ops');
    await user.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('this conversation is a channel already');
    apiFetchMock.mockRejectedValueOnce('nope');
    await user.click(screen.getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(screen.getByTestId('convert-submit-error')).toHaveTextContent('Failed to convert'));
  });

  it('converts from the top bar on a phone', async () => {
    mockIsMobile = true;
    apiFetchMock.mockResolvedValue({ id: 'g-1', slug: 'ops', name: 'ops', type: 'private' });
    const user = userEvent.setup();
    renderDialog();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'ops');
    await user.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByTestId('channel-page')).toBeInTheDocument();
  });

  it('closes without converting', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByText('Cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  // On a phone the form's one field submits it with Enter; a name that can't
  // be a channel goes nowhere.
  it('does nothing for a name that can\'t be a channel', async () => {
    mockIsMobile = true;
    const user = userEvent.setup();
    renderDialog();
    const name = screen.getByLabelText('Name');
    const submitted = vi.fn();
    name.closest('form')!.addEventListener('submit', submitted);
    await user.type(name, 'a'.repeat(40));
    await user.type(name, '{Enter}');
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('says it is converting on a phone', async () => {
    mockIsMobile = true;
    apiFetchMock.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Name'), 'ops');
    await user.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByRole('button', { name: 'Converting...' })).toBeDisabled();
  });
});
