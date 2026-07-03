import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

// Unlike MessageItem.reminder.browser.test (which mocks useActivity to spy on
// mutate), this drives the REAL useCreateReminder hook and only stubs apiFetch,
// proving the "Remind me" flow actually issues POST /api/v1/reminders.

const apiFetchMock = vi.hoisted(() => vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({ id: 'r1' })));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSetNoUnfurl: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useEmoji', () => ({ useEmojis: () => ({ data: [] }), useEmojiMap: () => ({ data: {} }) }));
vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));
vi.mock('@/hooks/useUnfurl', () => ({ useUnfurl: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/useSwipeDismiss', () => ({ useSwipeDismiss: () => ({ dismissing: false, motionProps: {} }) }));

function renderItem(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

function makeMessage(): Message {
  return { id: 'msg-1', parentID: 'channel-1', parentType: 'channel', authorID: 'user-2', body: 'Hi', createdAt: '2026-04-24T10:30:00Z' };
}

function reminderPosts(): Array<[string, { method?: string; body: string }]> {
  return apiFetchMock.mock.calls.filter((c) => c[0] === '/api/v1/reminders') as Array<
    [string, { method?: string; body: string }]
  >;
}

beforeEach(() => apiFetchMock.mockClear());
afterEach(() => cleanup());

describe('MessageItem "Remind me" — real POST', () => {
  it('a preset issues POST /api/v1/reminders with the message + future time', async () => {
    if (window.innerWidth <= 767) return; // desktop menu
    const screen = await renderItem(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} channelId="channel-1" channelSlug="general" />,
    );
    await userEvent.click(document.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement);
    await userEvent.click(screen.getByTestId('remind-me-trigger'));
    await userEvent.click(screen.getByTestId('remind-in1h'));

    await vi.waitFor(() => expect(reminderPosts().length).toBe(1));
    const [, opts] = reminderPosts()[0];
    expect(opts.method).toBe('POST');
    const sent = JSON.parse(opts.body);
    expect(sent).toMatchObject({ messageID: 'msg-1', parentID: 'channel-1', parentType: 'channel' });
    expect(new Date(sent.remindAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('the custom dialog issues POST /api/v1/reminders for the chosen time', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderItem(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} channelId="channel-1" channelSlug="general" />,
    );
    await userEvent.click(document.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement);
    await userEvent.click(screen.getByTestId('remind-me-trigger'));
    await userEvent.click(screen.getByTestId('remind-custom'));
    await userEvent.fill(screen.getByTestId('reminder-datetime'), '2999-01-01T09:00');
    await userEvent.click(screen.getByTestId('reminder-confirm'));

    await vi.waitFor(() => expect(reminderPosts().length).toBe(1));
    const sent = JSON.parse(reminderPosts()[0][1].body);
    expect(sent.remindAt.startsWith('2999')).toBe(true);
  });

  it('a mobile-sheet reminder issues POST /api/v1/reminders via the date-selector popup', async () => {
    if (window.innerWidth > 767) return; // mobile sheet only
    await renderItem(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} channelId="channel-1" channelSlug="general" currentUserId="user-9" />,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="mobile-message-actions"]')).not.toBeNull(), { timeout: 1500 });
    await userEvent.click(document.querySelector('[data-testid="mobile-remind"]') as HTMLButtonElement);
    const input = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="reminder-datetime"]') as HTMLInputElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    await userEvent.fill(input, '2999-01-01T09:00');
    // On mobile the confirm lives in the dialog's top-right header (the iOS
    // date wheel covers a bottom footer).
    await userEvent.click(document.querySelector('[data-slot="dialog-mobile-action"]') as HTMLButtonElement);
    await vi.waitFor(() => expect(reminderPosts().length).toBe(1));
    expect(reminderPosts()[0][1].method).toBe('POST');
  });
});
