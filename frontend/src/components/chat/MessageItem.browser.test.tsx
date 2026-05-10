import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import { expectPaintedAtCenter } from '@/test/browser-assertions';
import { dispatchEditMessage } from '@/lib/window-events';
import type { Message } from '@/types';

const useAttachmentsBatchMock = vi.hoisted(() => vi.fn(() => ({ map: new Map(), isLoading: false })));

vi.mock('@/hooks/useMessages', () => ({
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

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: (...args: unknown[]) => useAttachmentsBatchMock(...args),
}));

function renderWithProviders(ui: React.ReactElement) {
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
    authorID: 'user-1',
    body: 'Hello world',
    createdAt: '2026-04-24T10:30:00Z',
    ...overrides,
  };
}

describe('MessageItem browser behavior', () => {
  it('opens the desktop inline message editor after an empty settled attachment lookup', async () => {
    if (window.innerWidth <= 767) return;
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), isLoading: false });
    const screen = await renderWithProviders(
      <MessageItem
        message={makeMessage({ attachmentIDs: ['missing-attachment'] })}
        authorName="Alice"
        isOwn={true}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );

    dispatchEditMessage({ messageId: 'msg-1' });

    const editor = screen.getByTestId('inline-edit');
    await expect.element(editor).toBeVisible();
    await expect.element(screen.getByLabelText('Message input')).toBeVisible();
    expect(document.body.textContent).not.toContain('Loading');
  });

  it('keeps the mobile long-press action sheet above the bottom composer', async () => {
    if (window.innerWidth > 767) return;

    const screen = await renderWithProviders(
      <>
        <div style={{ position: 'relative', zIndex: 0, transform: 'translateZ(0)' }}>
          <MessageItem
            message={makeMessage()}
            authorName="Alice"
            isOwn={true}
            channelId="channel-1"
            currentUserId="user-1"
          />
        </div>
        <div
          data-testid="bottom-composer"
          style={{
            position: 'fixed',
            inset: 'auto 0 0 0',
            zIndex: 60,
            height: 180,
            background: 'rgb(220, 38, 38)',
            color: 'white',
          }}
        >
          Write to ~general
        </div>
      </>,
    );

    const row = screen.getByTestId('message-actions-trigger').element().closest('[data-message-id]');
    expect(row).not.toBeNull();
    row!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));

    // Wait for the sheet to mount AND its 180ms slide-up entrance to
    // settle. Reading getBoundingClientRect mid-animation can return
    // a transformed rect with top === innerHeight (translateY(100%) at
    // animation start), producing a flake under CPU contention. We
    // therefore wait until either the animation is no longer running
    // or two consecutive frames report the same top value.
    await vi.waitFor(() => {
      const actions = document.querySelector('[data-testid="mobile-message-actions"]') as HTMLElement | null;
      expect(actions).not.toBeNull();
      const animations = typeof actions!.getAnimations === 'function' ? actions!.getAnimations() : [];
      const stillRunning = animations.some((anim) => anim.playState === 'running');
      expect(stillRunning).toBe(false);
      expect(actions!.getBoundingClientRect().top).toBeLessThan(window.innerHeight);
    }, { timeout: 2000 });

    const sheet = document.querySelector('[data-testid="mobile-message-actions"]') as HTMLElement;
    expect(sheet.parentElement?.parentElement).toBe(document.body);
    expectPaintedAtCenter(sheet, '[data-testid="mobile-message-actions"]');
  });

  it('routes mobile edit immediately even when an attachment lookup has settled empty', async () => {
    if (window.innerWidth > 767) return;
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), isLoading: false });
    const onEditMessage = vi.fn();
    const screen = await renderWithProviders(
      <MessageItem
        message={makeMessage({ attachmentIDs: ['missing-attachment'] })}
        authorName="Alice"
        isOwn={true}
        channelId="channel-1"
        currentUserId="user-1"
        onEditMessage={onEditMessage}
      />,
    );

    const row = screen.getByTestId('message-actions-trigger').element().closest('[data-message-id]');
    expect(row).not.toBeNull();
    row!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="mobile-message-actions"]')).not.toBeNull();
    }, { timeout: 1000 });
    await screen.getByText('Edit').click();

    await vi.waitFor(() => {
      expect(onEditMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }));
      expect(document.body.textContent).not.toContain('Loading');
    });
  });
});
