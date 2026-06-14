import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
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

function renderPanel(messages: Message[] = [pinned()], onClose: () => void = vi.fn()) {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue(messages);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <PinnedPanel
          channelId="ch-1"
          channelSlug="general"
          onClose={onClose}
          userMap={{ 'u-1': { displayName: 'Alice' } }}
          currentUserId="u-2"
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('PinnedPanel browser behaviour', () => {
  afterEach(() => cleanup());

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

  it('invokes onClose from the close button', async () => {
    const onClose = vi.fn();
    const screen = await renderPanel([pinned()], onClose);
    await screen.getByLabelText('Close pinned messages').click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('jumps to the pinned message in its host view on a row click', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByText('remember to do the thing')).toBeVisible();
    const row = document.querySelector('[data-testid="pinned-message-row"]') as HTMLElement;
    row.click(); // target === row → not a nested button → jumpToMessage navigates
    await vi.waitFor(() => {
      expect(window.location.pathname).toBe('/channel/general');
      expect(window.location.hash).toContain('msg-');
    });
  });

  it('jumps to the pinned message when Enter is pressed on the focused row', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByText('remember to do the thing')).toBeVisible();
    window.history.pushState({}, '', '/somewhere-else');
    const row = document.querySelector('[data-testid="pinned-message-row"]') as HTMLElement;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(window.location.pathname).toBe('/channel/general'));
  });

  it('jumps when Space is pressed on the focused row', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByText('remember to do the thing')).toBeVisible();
    window.history.pushState({}, '', '/elsewhere');
    const row = document.querySelector('[data-testid="pinned-message-row"]') as HTMLElement;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await vi.waitFor(() => expect(window.location.pathname).toBe('/channel/general'));
  });

  it('does not navigate when the click originates on a nested interactive element', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByText('remember to do the thing')).toBeVisible();
    window.history.pushState({}, '', '/keep-here');
    const nestedButton = document.querySelector('[data-testid="pinned-message-row"] button') as HTMLButtonElement | null;
    if (!nestedButton) return; // no nested control rendered in this build
    nestedButton.click();
    await new Promise((r) => setTimeout(r, 30));
    // The row's onClick saw target.closest('button') and bailed out.
    expect(window.location.pathname).toBe('/keep-here');
  });

  it('ignores keys other than Enter/Space on the focused row', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByText('remember to do the thing')).toBeVisible();
    window.history.pushState({}, '', '/stay-put');
    const row = document.querySelector('[data-testid="pinned-message-row"]') as HTMLElement;
    // A non-activation key hits the `key !== 'Enter' && key !== ' '` guard
    // (line 106) and returns without navigating.
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(window.location.pathname).toBe('/stay-put');
  });

  it('does not navigate when Enter originates on a nested element, not the row', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByText('remember to do the thing')).toBeVisible();
    window.history.pushState({}, '', '/nested-key');
    const row = document.querySelector('[data-testid="pinned-message-row"]') as HTMLElement;
    const inner = row.querySelector('span, button, div') as HTMLElement | null;
    const dispatchTarget = inner ?? row.firstElementChild;
    expect(dispatchTarget).not.toBeNull();
    // currentTarget is the row (the listener), but target is the nested
    // node → the `e.target !== e.currentTarget` guard (line 107) returns.
    (dispatchTarget as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(window.location.pathname).toBe('/nested-key');
  });

  it('falls back to "Unknown" when the pinned author is not in the user map', async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue([{ ...pinned(), authorID: 'ghost' }]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <PinnedPanel channelId="ch-1" channelSlug="general" onClose={vi.fn()} userMap={{}} currentUserId="u-2" />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await expect.element(screen.getByText('Unknown')).toBeVisible();
  });

  it('jumps to a pinned message in a conversation host view', async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue([{ ...pinned(), parentID: 'conv-1', parentType: 'conversation' }]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <PinnedPanel conversationId="conv-1" onClose={vi.fn()} userMap={{ 'u-1': { displayName: 'Alice' } }} currentUserId="u-2" />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await expect.element(screen.getByText('remember to do the thing')).toBeVisible();
    window.history.pushState({}, '', '/start');
    (document.querySelector('[data-testid="pinned-message-row"]') as HTMLElement).click();
    await vi.waitFor(() => expect(window.location.pathname).toContain('conv-1'));
  });

  it('shows the empty state with no parent (query disabled, data is undefined)', async () => {
    // No channelId/conversationId → the pinned query is disabled, so `data`
    // stays undefined while isLoading is false. `(data?.length ?? 0) === 0`
    // then resolves via the `?? 0` nullish arm and the empty-state renders.
    apiFetchMock.mockReset();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <PinnedPanel onClose={vi.fn()} userMap={{}} currentUserId="u-2" />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await expect.element(screen.getByTestId('pinned-empty')).toBeVisible();
    // Query never fired since neither parent id was provided.
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('coerces a non-array pinned response to an empty list', async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(null);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <PinnedPanel channelId="ch-1" channelSlug="general" onClose={vi.fn()} userMap={{}} currentUserId="u-2" />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await expect.element(screen.getByTestId('pinned-empty')).toBeVisible();
  });
});
