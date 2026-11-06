import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ReminderMark } from './ReminderMark';
import { queryKeys } from '@/lib/query-keys';
import type { Reminder } from '@/types';

const reminder = (userIDs?: string[], more: Partial<Reminder> = {}): Reminder => ({
  id: 'r-1',
  userID: 'u-1',
  messageID: 'm-1',
  parentID: 'ch-1',
  parentType: 'channel',
  remindAt: '2099-03-04T09:30:00',
  createdAt: '',
  userIDs,
  ...more,
});

async function renderMark(r: Reminder) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Bob is known; anyone else reads as "Someone".
  qc.setQueryData(queryKeys.usersBatch(['u-2', 'u-gone']), [{ id: 'u-2', displayName: 'Bob', email: '', systemRole: 'member', status: 'active' }]);
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ReminderMark reminder={r} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const mark = () => document.querySelector<HTMLButtonElement>('[data-testid="message-reminder-mark"]')!;

afterEach(() => window.history.replaceState(null, '', '/'));

describe('the reminder mark on a message', () => {
  it('says when it is due and who else it tags', async () => {
    await renderMark(reminder(['u-2', 'u-gone']));
    expect(mark().getAttribute('aria-label')).toMatch(/^Reminder, .*9:30/);
    await userEvent.hover(mark());
    await expect.poll(() => document.body.textContent).toContain('With Bob, Someone');
    expect(document.body.textContent).toMatch(/Reminder · .*9:30/);
  });

  it('says a reminder is for everyone, minus whoever is left out', async () => {
    await renderMark(reminder(undefined, { everyone: true, excludedUserIDs: ['u-2', 'u-gone'] }));
    await userEvent.hover(mark());
    await expect.poll(() => document.body.textContent).toContain('With everyone except Bob, Someone');
  });

  it('says a reminder is for everyone', async () => {
    await renderMark(reminder(undefined, { everyone: true }));
    await userEvent.hover(mark());
    await expect.poll(() => document.body.textContent).toContain('With everyone');
    expect(document.body.textContent).not.toContain('except');
  });

  it('names no one on a personal reminder, and opens the Reminders tab', async () => {
    await renderMark(reminder());
    await userEvent.hover(mark());
    await expect.poll(() => document.body.textContent).toMatch(/Reminder · /);
    expect(document.body.textContent).not.toContain('With ');
    await userEvent.click(mark());
    await expect.poll(() => window.location.pathname + window.location.search).toBe('/drafts?tab=reminders');
  });
});
