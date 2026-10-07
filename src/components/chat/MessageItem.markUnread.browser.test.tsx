import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

// "Mark as unread" in the desktop menu and the mobile action sheet: which
// message, which chat, and where it isn't offered.

const createReminderMutate = vi.hoisted(() => vi.fn());
const createReminderMutateAsync = vi.hoisted(() => vi.fn(() => Promise.resolve({ id: 'r1' })));
const markUnreadMutate = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useMarkUnread', () => ({
  useMarkUnread: () => ({ mutate: markUnreadMutate, isPending: false }),
}));
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
  await userEvent.click(document.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement);
}

beforeEach(() => markUnreadMutate.mockClear());
afterEach(() => cleanup());

describe('MessageItem "Mark as unread"', () => {
  const views = [
    { name: 'channel', props: { channelId: 'channel-1', channelSlug: 'general' }, parentID: 'channel-1', parentType: 'channel' },
    { name: 'self-DM', props: { conversationId: 'self-1' }, parentID: 'self-1', parentType: 'conversation' },
  ] as const;

  for (const view of views) {
    it(`desktop: marks a ${view.name} message unread`, async () => {
      if (window.innerWidth <= 767) return;
      const screen = await renderItem(
        <MessageItem message={makeMessage({ id: 'm-7', parentID: view.parentID, parentType: undefined })} authorName="Alice" isOwn={false} {...view.props} />,
      );
      await openMenu();
      await userEvent.click(screen.getByTestId('mark-unread'));
      expect(markUnreadMutate).toHaveBeenCalledWith({ parentID: view.parentID, parentType: view.parentType, messageID: 'm-7' });
    });

    it(`mobile: marks a ${view.name} message unread from the action sheet, closing it`, async () => {
      if (window.innerWidth > 767) return;
      await renderItem(
        <MessageItem message={makeMessage({ id: 'm-8', parentID: view.parentID, parentType: undefined })} authorName="Alice" isOwn={false} currentUserId="user-9" {...view.props} />,
      );
      await openMobileSheet();
      await userEvent.click(document.querySelector('[data-testid="mobile-mark-unread"]') as HTMLButtonElement);
      expect(markUnreadMutate).toHaveBeenCalledWith({ parentID: view.parentID, parentType: view.parentType, messageID: 'm-8' });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="mobile-message-actions"]')).toBeNull());
    });
  }

  it('desktop: offered on a thread reply in the thread view', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderItem(
      <MessageItem message={makeMessage({ id: 'r-1', parentMessageID: 'root-1' })} authorName="Alice" isOwn={false} channelId="channel-1" inThread />,
    );
    await openMenu();
    await userEvent.click(screen.getByTestId('mark-unread'));
    expect(markUnreadMutate).toHaveBeenCalledWith({ parentID: 'channel-1', parentType: 'channel', messageID: 'r-1' });
  });

  it('desktop: not offered on the thread root inside the thread view', async () => {
    if (window.innerWidth <= 767) return;
    await renderItem(<MessageItem message={makeMessage({ id: 'root-1' })} authorName="Alice" isOwn={false} channelId="channel-1" inThread />);
    await openMenu();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Copy link to message"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="mark-unread"]')).toBeNull();
  });

  it('mobile: not offered on the thread root inside the thread view', async () => {
    if (window.innerWidth > 767) return;
    await renderItem(
      <MessageItem message={makeMessage({ id: 'root-1' })} authorName="Alice" isOwn={false} channelId="channel-1" currentUserId="user-9" inThread />,
    );
    await openMobileSheet();
    expect(document.querySelector('[data-testid="mobile-mark-unread"]')).toBeNull();
  });
});
