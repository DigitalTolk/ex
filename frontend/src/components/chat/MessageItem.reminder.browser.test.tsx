import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

// Browser-only surface: the desktop "Remind me" submenu (base-ui Submenu needs a
// real browser) and its channel/conversation target computation + custom dialog.

const createReminderMutate = vi.hoisted(() => vi.fn());
const createReminderMutateAsync = vi.hoisted(() => vi.fn(() => Promise.resolve({ id: 'r1' })));
vi.mock('@/hooks/useActivity', () => ({
  useCreateReminder: () => ({ mutate: createReminderMutate, mutateAsync: createReminderMutateAsync, isPending: false }),
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
vi.mock('@/hooks/useSwipeDismiss', () => ({
  useSwipeDismiss: () => ({ dismissing: false, motionProps: {} }),
}));

async function openMobileSheet() {
  const row = document.querySelector('[data-message-id]') as HTMLElement;
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="mobile-message-actions"]')).not.toBeNull();
  }, { timeout: 1500 });
}

function renderItem(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    parentID: 'channel-1',
    parentType: 'channel',
    authorID: 'user-2',
    body: 'Hello world',
    createdAt: '2026-04-24T10:30:00Z',
    ...overrides,
  };
}

async function openMenu() {
  await userEvent.click(document.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement);
}

beforeEach(() => { createReminderMutate.mockClear(); createReminderMutateAsync.mockClear(); });
afterEach(() => cleanup());

describe('MessageItem "Remind me"', () => {
  it('schedules a preset reminder for a channel message', async () => {
    if (window.innerWidth <= 767) return; // desktop menu only
    const screen = await renderItem(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} channelId="channel-1" channelSlug="general" />,
    );
    await openMenu();
    await userEvent.click(screen.getByTestId('remind-me-trigger'));
    await userEvent.click(screen.getByTestId('remind-in1h'));
    expect(createReminderMutate).toHaveBeenCalledTimes(1);
    const arg = createReminderMutate.mock.calls[0][0];
    expect(arg).toMatchObject({ messageID: 'msg-1', parentID: 'channel-1', parentType: 'channel', channelSlug: 'general' });
    expect(typeof arg.remindAt).toBe('string');
  });

  it('schedules a preset reminder for a conversation message', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderItem(
      <MessageItem
        message={makeMessage({ parentID: 'conv-1', parentType: 'conversation' })}
        authorName="Alice"
        isOwn={false}
        conversationId="conv-1"
      />,
    );
    await openMenu();
    await userEvent.click(screen.getByTestId('remind-me-trigger'));
    await userEvent.click(screen.getByTestId('remind-tomorrow'));
    expect(createReminderMutate.mock.calls[0][0]).toMatchObject({ parentID: 'conv-1', parentType: 'conversation' });
  });

  it('opens the custom dialog and schedules a chosen time', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderItem(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} channelId="channel-1" channelSlug="general" />,
    );
    await openMenu();
    await userEvent.click(screen.getByTestId('remind-me-trigger'));
    await userEvent.click(screen.getByTestId('remind-custom'));
    const input = screen.getByTestId('reminder-datetime');
    await userEvent.fill(input, '2999-01-01T09:00');
    await userEvent.click(screen.getByTestId('reminder-confirm'));
    await vi.waitFor(() => expect(createReminderMutateAsync).toHaveBeenCalledTimes(1));
    expect((createReminderMutateAsync.mock.calls[0][0].remindAt as string).startsWith("2999")).toBe(true);
  });

  it('mobile action sheet shows a single Remind me item (no inline preset list) that opens the dialog', async () => {
    if (window.innerWidth > 767) return; // mobile sheet only
    await renderItem(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} channelId="channel-1" channelSlug="general" currentUserId="user-9" />,
    );
    await openMobileSheet();
    // The old inline preset group (which made the sheet tall enough to cover the
    // whole screen) is gone — a single item remains.
    expect(document.querySelector('[data-testid="mobile-remind-group"]')).toBeNull();
    expect(document.querySelector('[data-testid="mobile-remind-in1h"]')).toBeNull();
    const remind = document.querySelector('[data-testid="mobile-remind"]') as HTMLButtonElement;
    expect(remind).not.toBeNull();
    // Tapping it opens the separate date-selector popup right away.
    await userEvent.click(remind);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="reminder-datetime"]')).not.toBeNull());
  });

  it('schedules a reminder from the mobile action sheet via the date-selector popup', async () => {
    if (window.innerWidth > 767) return;
    await renderItem(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} channelId="channel-1" channelSlug="general" currentUserId="user-9" />,
    );
    await openMobileSheet();
    await userEvent.click(document.querySelector('[data-testid="mobile-remind"]') as HTMLButtonElement);
    const input = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="reminder-datetime"]') as HTMLInputElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    await userEvent.fill(input, '2999-03-03T08:00');
    await userEvent.click(document.querySelector("[data-testid=\"reminder-confirm\"]") as HTMLButtonElement);
    await vi.waitFor(() => expect(createReminderMutateAsync).toHaveBeenCalledTimes(1));
  });
});
