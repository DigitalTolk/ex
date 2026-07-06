import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import { expectPaintedAtCenter } from '@/test/browser-assertions';
import { dispatchEditMessage } from '@/lib/window-events';
import type { Message } from '@/types';

const useAttachmentsBatchMock = vi.hoisted(() => vi.fn(() => ({ map: new Map(), isLoading: false })));

const toggleReactionMutate = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: toggleReactionMutate, isPending: false }),
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

  it('renders quick-reaction shortcuts in the desktop toolbar and reacts on click', async () => {
    if (window.innerWidth <= 767) return;
    toggleReactionMutate.mockClear();
    const screen = await renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-2"
        quickReactions={[':tada:', ':smile:']}
      />,
    );
    const btn = screen.getByRole('button', { name: 'React with :tada:' });
    await expect.element(btn).toBeInTheDocument();
    await btn.click();
    expect(toggleReactionMutate).toHaveBeenCalledWith(expect.objectContaining({ emoji: ':tada:' }));
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

    // 2s, not 1s: the sheet opens only after the 420ms long-press timer,
    // and webkit under full-suite CPU load can eat the rest of a 1s window
    // (same rationale as the entrance-animation wait above).
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="mobile-message-actions"]')).not.toBeNull();
    }, { timeout: 2000 });
    await screen.getByText('Edit').click();

    await vi.waitFor(() => {
      expect(onEditMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }));
      expect(document.body.textContent).not.toContain('Loading');
    });
  });

  it('renders reaction badges with their counts', async () => {
    await renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { ':thumbsup:': ['user-2', 'user-3'] } })}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    await vi.waitFor(() => {
      const badge = document.querySelector('[data-testid="reaction-badge"]');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toContain('2');
    });
  });

  it('mobile: long-pressing a reaction chip lists who reacted without toggling', async () => {
    if (window.innerWidth > 767) return;
    toggleReactionMutate.mockClear();
    const toasts: Array<{ message: string }> = [];
    const onToast = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail);
    window.addEventListener('app:toast', onToast);
    try {
      await renderWithProviders(
        <MessageItem
          message={makeMessage({ reactions: { ':thumbsup:': ['user-2', 'user-3'] } })}
          authorName="Alice"
          isOwn={false}
          channelId="channel-1"
          currentUserId="user-1"
          userMap={{ get: (id: string) => ({ displayName: id === 'user-2' ? 'Bob' : 'Carol' }) }}
        />,
      );
      const badge = document.querySelector('[data-testid="reaction-badge"]') as HTMLElement;
      badge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      // The reactor list surfaces as a toast (the hover tooltip is
      // unreachable on touch).
      await vi.waitFor(() => expect(toasts.length).toBe(1), { timeout: 1500 });
      expect(toasts[0].message).toContain('Bob');
      expect(toasts[0].message).toContain('reacted with');
      // The chip press must NOT arm the row's long-press action sheet.
      expect(document.querySelector('[data-testid="mobile-message-actions"]')).toBeNull();
      // The click a touch release fires is swallowed: peeking at reactors
      // must not toggle the viewer's reaction.
      badge.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
      badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(toggleReactionMutate).not.toHaveBeenCalled();
      // A plain tap afterwards still toggles.
      badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(toggleReactionMutate).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('app:toast', onToast);
    }
  });

  it('invokes onReplyInThread from the desktop thread-reply action on hover', async () => {
    if (window.innerWidth <= 767) return;
    const onReplyInThread = vi.fn();
    await renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
        onReplyInThread={onReplyInThread}
      />,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    // The desktop hover toolbar exposes the reply control; click the first
    // visible "Reply in thread" button.
    const replyBtn = Array.from(document.querySelectorAll('button[aria-label="Reply in thread"]'))
      .find((b) => (b as HTMLElement).offsetParent !== null) as HTMLButtonElement | undefined;
    expect(replyBtn).toBeDefined();
    replyBtn!.click();
    expect(onReplyInThread).toHaveBeenCalledWith('msg-1');
  });

  it('renders a message in a conversation context (builds the conversation deep-link)', async () => {
    await renderWithProviders(
      <MessageItem
        message={makeMessage({ parentID: 'conv-1', parentType: 'conversation' })}
        authorName="Bob"
        isOwn={false}
        conversationId="conv-1"
        currentUserId="user-1"
      />,
    );
    // The conversation branch of the deep-link builder runs (slug is absent,
    // conversationId present); the row renders its body either way.
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Hello world');
    });
  });

  it('renders a deleted message tombstone instead of the body', async () => {
    await renderWithProviders(
      <MessageItem
        message={makeMessage({ deleted: true, body: '' })}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    await vi.waitFor(() => {
      expect(document.body.textContent).toMatch(/deleted/i);
    });
  });

  it('shows the full avatar + name header for the first message of a group', async () => {
    const screen = await renderWithProviders(
      <MessageItem
        message={makeMessage({ body: 'first of group' })}
        firstInGroup
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    await expect.element(screen.getByText('Alice')).toBeVisible();
    // The first message keeps a real timestamp header, not a gutter stand-in.
    expect(document.querySelector('[data-testid="group-time-gutter"]')).toBeNull();
  });

  it('renders a compact continuation (no name header, hover-only gutter time) when grouped', async () => {
    await renderWithProviders(
      <MessageItem
        message={makeMessage({ body: 'second of group' })}
        firstInGroup={false}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('second of group');
    });
    // Author name header is suppressed on a continuation row…
    expect(document.body.textContent).not.toContain('Alice');
    // …replaced by the gutter timestamp element, whose visibility is tied to
    // row hover via an opacity class (covered across the hovered desktop and
    // non-hovered mobile browser projects).
    const gutter = document.querySelector('[data-testid="group-time-gutter"]');
    expect(gutter).not.toBeNull();
    const time = gutter?.querySelector('time');
    expect(time).not.toBeNull();
    expect(time?.className).toMatch(/opacity-(0|100)/);
  });
});
