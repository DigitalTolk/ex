import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

const actions = vi.hoisted(() => ({ retry: vi.fn(), discard: vi.fn() }));
vi.mock('@/hooks/useMessages', () => ({
  usePendingMessageActions: () => actions,
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSetNoUnfurl: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

// Sending → sent (or → failed) must not move anything: the status lives in
// space the row already has, so the row keeps its exact height.
const base: Message = {
  id: 'pending-n1',
  parentID: 'channel-1',
  authorID: 'user-1',
  body: 'Rollout is at nine, I will post the checklist',
  createdAt: '2026-10-07T10:30:00Z',
  clientNonce: 'n1',
};

// Height once layout has settled (fonts loaded, two frames painted) — WebKit
// reports a taller first-paint box before its fonts are in.
async function settledHeight(): Promise<number> {
  await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return document.querySelector<HTMLElement>('[data-message-id]')!.getBoundingClientRect().height;
}

async function heightsAcross(firstInGroup: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (message: Message) => (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MessageItem message={message} authorName="Alice" isOwn currentUserId="user-1" firstInGroup={firstInGroup} />
      </BrowserRouter>
    </QueryClientProvider>
  );
  const screen = await render(ui({ ...base, pendingState: 'sending' }));
  await expect.element(screen.getByTestId('message-sending')).toBeInTheDocument();
  const sending = await settledHeight();
  await screen.rerender(ui({ ...base, pendingState: 'failed' }));
  await expect.element(screen.getByTestId('message-failed')).toBeVisible();
  const failed = await settledHeight();
  await screen.rerender(ui({ ...base, id: '01REAL' }));
  await expect.element(screen.getByTestId('message-sending')).not.toBeInTheDocument();
  const sent = await settledHeight();
  return { sending, failed, sent };
}

describe('MessageItem — optimistic rows keep their layout', () => {
  it('a first-in-group row keeps its height from sending to failed to sent', async () => {
    const { sending, failed, sent } = await heightsAcross(true);
    expect(failed).toBe(sending);
    expect(sent).toBe(sending);
  });

  it('a grouped row keeps its height too', async () => {
    const { sending, failed, sent } = await heightsAcross(false);
    expect(failed).toBe(sending);
    expect(sent).toBe(sending);
  });

  it("a grouped row's time never flashes when its failed mark goes away", async () => {
    const qc = new QueryClient();
    const ui = (message: Message) => (
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <MessageItem message={message} authorName="Alice" isOwn currentUserId="user-1" firstInGroup={false} />
        </BrowserRouter>
      </QueryClientProvider>
    );
    const screen = await render(ui({ ...base, pendingState: 'failed' }));
    await expect.element(screen.getByTestId('message-failed')).toBeVisible();
    // This checks the row at rest. A real pointer crossing it mid-check (the
    // browser's single mouse is shared with whatever else is running) starts
    // the legitimate hover fade-in and fails the check for the wrong reason,
    // so the row is made unhoverable for its duration.
    screen.container.style.pointerEvents = 'none';
    const time = () => document.querySelector<HTMLElement>('[data-testid="group-time-gutter"] time')!;
    // The pointer may already have crossed the row before pointer-events was
    // cut (another file's hover moves the same mouse): end that hover and let
    // its fade-out finish, so what follows measures the rerenders alone.
    document.querySelector('[data-message-id]')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    await vi.waitFor(() => expect(getComputedStyle(time()).opacity).toBe('0'), { timeout: 2000 });
    // Retried, then sent: the hover-only time must stay at opacity 0 the
    // whole way (it used to jump to 1 and fade out — a visible flash).
    await screen.rerender(ui({ ...base, pendingState: 'sending' }));
    expect(getComputedStyle(time()).opacity).toBe('0');
    await screen.rerender(ui({ ...base, id: '01REAL' }));
    expect(getComputedStyle(time()).opacity).toBe('0');
  });

  it('the red mark opens Try again / Delete', async () => {
    const qc = new QueryClient();
    const failed: Message = { ...base, pendingState: 'failed' };
    const screen = await render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <MessageItem message={failed} authorName="Alice" isOwn currentUserId="user-1" />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await screen.getByTestId('message-failed').click();
    await screen.getByRole('menuitem', { name: 'Try sending again' }).click();
    expect(actions.retry).toHaveBeenCalledWith(failed);
  });
});
