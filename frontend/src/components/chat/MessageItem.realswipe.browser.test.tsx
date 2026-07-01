import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import { swipe } from '@/test/gestures';
import type { Message } from '@/types';

// REAL-surface proof that the swipe() helper drives the actual app gesture:
// the mobile message action sheet is a real motion.div wired to the REAL
// useSwipeDismiss('down', closeMobileActions). Long-press opens it, and a real
// downward finger drag past the threshold must animate it away and close it.
// (Every other MessageItem browser test mocks useSwipeDismiss — this one does not.)

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSetNoUnfurl: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useActivity', () => ({
  useCreateReminder: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useEmoji', () => ({ useEmojis: () => ({ data: [] }), useEmojiMap: () => ({ data: {} }) }));
vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));
vi.mock('@/hooks/useUnfurl', () => ({ useUnfurl: () => ({ data: undefined, isLoading: false }) }));

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

const sheet = () => document.querySelector('[data-testid="mobile-message-actions"]') as HTMLElement | null;

async function openMobileSheet() {
  const row = document.querySelector('[data-message-id]') as HTMLElement;
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', isPrimary: true }));
  await vi.waitFor(() => expect(sheet()).not.toBeNull(), { timeout: 1500 });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('MessageItem mobile action sheet — real swipe-to-dismiss', () => {
  it('swiping the action sheet down closes it', async () => {
    if (window.innerWidth > 767) return; // mobile sheet only
    await renderItem(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        channelSlug="general"
        currentUserId="user-9"
      />,
    );

    await openMobileSheet();
    const el = sheet();
    expect(el).not.toBeNull();

    // A real downward drag well past DISMISS_DISTANCE (72px).
    await swipe(el!, { dy: 240, steps: 8, stepMs: 18 });

    // onDismiss (closeMobileActions) fires after the exit spring completes.
    await vi.waitFor(() => expect(sheet()).toBeNull(), { timeout: 2000 });
  });
});
