import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityReminderDialog } from './ActivityReminderDialog';
import { newActivityReminder } from '@/lib/activity-reminder';
import { groupActivity } from '@/lib/activity-feed';
import { apiFetch } from '@/lib/api';
import type { ActivityItem } from '@/types';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<object>()), apiFetch: vi.fn() }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

const item: ActivityItem = {
  id: 'a',
  type: 'mention',
  createdAt: new Date().toISOString(),
  messageID: 'm-1',
  parentID: 'ch-1',
  parentType: 'channel',
  actorID: 'u-1',
  read: false,
};

function renderDialog(reminder: ReturnType<typeof newActivityReminder> | null, onClose = vi.fn(), channelSlug?: string) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ActivityReminderDialog reminder={reminder} channelSlug={channelSlug} onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe('ActivityReminderDialog', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue({ id: 'r-1' } as never);
  });

  it('renders nothing without a reminder', () => {
    renderDialog(null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('schedules a reminder on the row message, with the channel slug, then closes', async () => {
    const reminder = newActivityReminder(groupActivity([item])[0]);
    expect(reminder.seed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const onClose = renderDialog(reminder, vi.fn(), 'general');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('reminder-quick-in1h'));
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/v1/reminders',
        expect.objectContaining({ method: 'POST', body: expect.stringContaining('"messageID":"m-1"') }),
      ),
    );
    const body = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ parentID: 'ch-1', parentType: 'channel', channelSlug: 'general' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('treats a DM as a conversation, and closes on cancel', async () => {
    const onClose = renderDialog(newActivityReminder(groupActivity([{ ...item, parentType: 'conversation', parentID: 'cv-1' }])[0]));
    fireEvent.click(screen.getByTestId('reminder-quick-in1h'));
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const body = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ parentID: 'cv-1', parentType: 'conversation' });
    expect(body.channelSlug).toBeUndefined();
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    onClose.mockClear();
    fireEvent.click(screen.getByTestId('reminder-cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
