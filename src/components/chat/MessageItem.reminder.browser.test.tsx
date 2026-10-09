import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

// Hover without moving the browser's one real mouse (other files run in
// parallel and a real pointer crossing their rows makes hover-only checks
// flake): React derives onMouseEnter from mouseover, and a tick lets the
// hover state flush.
async function hoverRow(row: Element | null) {
  row?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
}


// Browser-only surface: the desktop "Remind me" submenu (base-ui Submenu needs a
// real browser) and its channel/conversation target computation + custom dialog.

const createReminderMutate = vi.hoisted(() => vi.fn());
const createReminderMutateAsync = vi.hoisted(() => vi.fn(() => Promise.resolve({ id: 'r1' })));
vi.mock('@/hooks/useActivity', () => ({
  useCreateReminder: () => ({ mutate: createReminderMutate, mutateAsync: createReminderMutateAsync, isPending: false }),
}));

vi.mock('@/hooks/useMessages', () => ({
  usePendingMessageActions: () => ({ retry: vi.fn(), discard: vi.fn() }),
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
  }, { timeout: 2000 });
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
  // The toolbar mounts on hover (MessageItem): hover the row first.
  await hoverRow(document.querySelector('[data-message-id]'));
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

  // THE reported bug: messages loaded from the list API carry no parentType
  // (only live WebSocket frames do). In a DM that used to fall back to
  // "channel" and the server rejected the reminder (403). The view the row
  // renders in decides.
  it('schedules a DM reminder as a conversation even when the message has no parentType', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderItem(
      <MessageItem
        message={makeMessage({ parentID: 'conv-1', parentType: undefined })}
        authorName="Alice"
        isOwn={false}
        conversationId="conv-1"
      />,
    );
    await openMenu();
    await userEvent.click(screen.getByTestId('remind-me-trigger'));
    await userEvent.click(screen.getByTestId('remind-in1h'));
    expect(createReminderMutate.mock.calls[0][0]).toMatchObject({ parentID: 'conv-1', parentType: 'conversation' });
  });

  it('falls back to the message parentType outside a channel/conversation view', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderItem(
      <MessageItem message={makeMessage({ parentID: 'conv-1', parentType: 'conversation' })} authorName="Alice" isOwn={false} />,
    );
    await openMenu();
    await userEvent.click(screen.getByTestId('remind-me-trigger'));
    await userEvent.click(screen.getByTestId('remind-in1h'));
    expect(createReminderMutate.mock.calls[0][0]).toMatchObject({ parentType: 'conversation' });
  });

  it('defaults to a channel when neither the view nor the message says', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderItem(
      <MessageItem message={makeMessage({ parentType: undefined })} authorName="Alice" isOwn={false} />,
    );
    await openMenu();
    await userEvent.click(screen.getByTestId('remind-me-trigger'));
    await userEvent.click(screen.getByTestId('remind-in1h'));
    expect(createReminderMutate.mock.calls[0][0]).toMatchObject({ parentType: 'channel' });
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
    // On mobile the confirm lives in the dialog's top-right header (the iOS
    // date wheel covers a bottom footer).
    await userEvent.click(document.querySelector('[data-slot="dialog-mobile-action"]') as HTMLButtonElement);
    await vi.waitFor(() => expect(createReminderMutateAsync).toHaveBeenCalledTimes(1));
  });
});

// "Reminders can be set on self-DM messages the same way as anywhere else."
// The same own message — top-level and as a thread reply — rendered in a
// channel, a DM and a self-DM (a conversation with only yourself) offers the
// same Remind me entry points and sends the same request, targeted at the view
// it renders in. The self-DM is just a conversation: nothing about it is
// special-cased.
describe('MessageItem "Remind me" — self-DM parity', () => {
  const views = [
    { name: 'channel', props: { channelId: 'channel-1', channelSlug: 'general' }, parentID: 'channel-1', parentType: 'channel' },
    { name: 'DM', props: { conversationId: 'dm-1' }, parentID: 'dm-1', parentType: 'conversation' },
    { name: 'self-DM', props: { conversationId: 'self-dm-1' }, parentID: 'self-dm-1', parentType: 'conversation' },
  ] as const;
  const shapes = [
    { name: 'top-level message', overrides: {}, inThread: false },
    { name: 'thread reply', overrides: { parentMessageID: 'root-1' }, inThread: true },
  ] as const;

  const ownMessage = (parentID: string, overrides: Partial<Message>) =>
    // List-API shape: no parentType on the message (only live frames carry it).
    makeMessage({ id: 'own-1', parentID, parentType: undefined, authorID: 'me', ...overrides });

  for (const view of views) {
    for (const shape of shapes) {
      it(`desktop presets + Custom on a ${shape.name} in a ${view.name}`, async () => {
        if (window.innerWidth <= 767) return;
        const screen = await renderItem(
          <MessageItem
            message={ownMessage(view.parentID, shape.overrides)}
            authorName="Me"
            isOwn
            currentUserId="me"
            inThread={shape.inThread}
            {...view.props}
          />,
        );
        await openMenu();
        await userEvent.click(screen.getByTestId('remind-me-trigger'));
        await userEvent.click(screen.getByTestId('remind-in20m'));
        const target = { messageID: 'own-1', parentID: view.parentID, parentType: view.parentType };
        expect(createReminderMutate).toHaveBeenCalledTimes(1);
        expect(createReminderMutate.mock.calls[0][0]).toMatchObject(target);

        await openMenu();
        await userEvent.click(screen.getByTestId('remind-me-trigger'));
        await userEvent.click(screen.getByTestId('remind-custom'));
        await userEvent.fill(screen.getByTestId('reminder-datetime'), '2999-01-01T09:00');
        await userEvent.click(screen.getByTestId('reminder-confirm'));
        await vi.waitFor(() => expect(createReminderMutateAsync).toHaveBeenCalledTimes(1));
        expect(createReminderMutateAsync.mock.calls[0][0]).toMatchObject(target);
      });

      it(`mobile sheet on a ${shape.name} in a ${view.name}`, async () => {
        if (window.innerWidth > 767) return;
        await renderItem(
          <MessageItem
            message={ownMessage(view.parentID, shape.overrides)}
            authorName="Me"
            isOwn
            currentUserId="me"
            inThread={shape.inThread}
            {...view.props}
          />,
        );
        await openMobileSheet();
        await userEvent.click(document.querySelector('[data-testid="mobile-remind"]') as HTMLButtonElement);
        const input = await vi.waitFor(() => {
          const el = document.querySelector('[data-testid="reminder-datetime"]') as HTMLInputElement | null;
          expect(el).not.toBeNull();
          return el!;
        });
        await userEvent.fill(input, '2999-03-03T08:00');
        await userEvent.click(document.querySelector('[data-slot="dialog-mobile-action"]') as HTMLButtonElement);
        await vi.waitFor(() => expect(createReminderMutateAsync).toHaveBeenCalledTimes(1));
        expect(createReminderMutateAsync.mock.calls[0][0]).toMatchObject({
          messageID: 'own-1',
          parentID: view.parentID,
          parentType: view.parentType,
        });
      });
    }
  }
});
