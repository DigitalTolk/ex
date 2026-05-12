import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PinnedPanel } from './PinnedPanel';
import type { Message } from '@/types';

// Real-browser smoke coverage for the pinned-message side panel.
// The component was at 0% browser coverage before this file — a
// regression in MessageItem hydration (the same kind that caused
// the message-list-renders-black bug) would never have surfaced
// here under unit tests alone.

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), mutate: vi.fn(), isPending: false }),
  uploadAttachment: vi.fn(),
}));

vi.mock('@/hooks/useThreads', () => ({
  useUserThreads: () => ({ data: [] }),
  useThreadMeta: () => undefined,
  markThreadSeen: vi.fn(),
}));

vi.mock('@/hooks/useReactions', () => ({
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
}));

function pinned(): Message {
  return {
    id: '01J0000000000000000000PIN1',
    parentID: 'ch-1',
    parentType: 'channel',
    authorID: 'u-1',
    body: 'remember to do the thing',
    createdAt: '2026-05-01T10:00:00Z',
    pinned: true,
  };
}

function renderPanel(messages: Message[] = [pinned()]) {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue(messages);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <PinnedPanel
          channelId="ch-1"
          channelSlug="general"
          onClose={vi.fn()}
          userMap={{ 'u-1': { displayName: 'Alice' } }}
          currentUserId="u-2"
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('PinnedPanel browser behaviour', () => {
  it('renders the pinned panel header', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByText('Pinned messages')).toBeVisible();
  });

  it('renders pinned message bodies fetched from the API', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByText('remember to do the thing')).toBeVisible();
  });

  it('renders an empty list cleanly when no messages are pinned', async () => {
    const screen = await renderPanel([]);
    await expect.element(screen.getByText('Pinned messages')).toBeVisible();
    // No author rows = nothing crashed.
    const items = document.querySelectorAll('[data-message-id]');
    expect(items.length).toBe(0);
  });

  it('renders the close button with the documented aria-label', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByLabelText('Close pinned messages')).toBeVisible();
  });
});
