import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

const mockEditMutate = vi.fn();
const mockDeleteMutate = vi.fn();
const mockReactMutate = vi.fn();
const mockPinMutate = vi.fn();

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: mockEditMutate, isPending: false }),
  useDeleteMessage: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useToggleReaction: () => ({ mutate: mockReactMutate, isPending: false }),
  useSetPinned: () => ({ mutate: mockPinMutate, isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

// Mock the dropdown menu so menu items render directly in jsdom
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown-content">{children}</div>,
  DropdownMenuItem: ({ children, onClick, ...rest }: { children: React.ReactNode; onClick?: () => void; variant?: string; 'aria-label'?: string }) => (
    <button data-testid="dropdown-item" onClick={onClick} aria-label={rest['aria-label']}>{children}</button>
  ),
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

function setMobileMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

describe('MessageItem', () => {
  it('renders author name and message body', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice Johnson"
        isOwn={false}
      />,
    );

    expect(screen.getByText('Alice Johnson')).toBeInTheDocument();
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('keeps rendered user and channel mention pills on the text baseline', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ body: '~[channel-1|general] hello @[user-2|Bob]' })}
        authorName="Alice Johnson"
        currentUserId="user-1"
        isOwn={false}
      />,
    );

    const channelPill = screen.getByTestId('channel-mention-pill');
    const userPill = screen.getByTestId('mention-pill');
    const userHoverTrigger = userPill.parentElement;

    expect(channelPill).toHaveClass('inline', 'align-baseline', 'leading-[inherit]');
    expect(userPill).toHaveClass('inline', 'align-baseline', 'leading-[inherit]');
    expect(userHoverTrigger).toHaveClass('inline', 'align-baseline');
    expect(userHoverTrigger).not.toHaveClass('inline-flex');
    expect(userHoverTrigger).not.toHaveClass('align-middle');
  });

  it('does not underline the author name on hover', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice Johnson"
        isOwn={false}
      />,
    );

    expect(screen.getByText('Alice Johnson')).not.toHaveClass('hover:underline');
  });

  it('renders the online indicator on the author avatar', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice Johnson"
        authorOnline
        authorUserStatus={{ emoji: ':house:', text: 'Working from home' }}
        isOwn={false}
      />,
    );

    expect(screen.getByLabelText('Online')).toBeInTheDocument();
  });

  it('shows formatted time', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ createdAt: '2026-04-24T14:05:00Z' })}
        authorName="Alice"
        isOwn={false}
      />,
    );

    // The time element should be present with the dateTime attribute
    const timeEl = document.querySelector('time[datetime="2026-04-24T14:05:00Z"]');
    expect(timeEl).toBeInTheDocument();
  });

  it('does NOT show "(edited)" when editedAt is undefined', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ editedAt: undefined })}
        authorName="Alice"
        isOwn={false}
      />,
    );

    expect(screen.queryByText('(edited)')).not.toBeInTheDocument();
  });

  it('shows "(edited)" when editedAt is set', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ editedAt: '2026-04-24T11:00:00Z' })}
        authorName="Alice"
        isOwn={false}
      />,
    );

    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });

  it('shows edit/delete buttons for own messages', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );

    // Edit/Delete are now inside a dropdown — open the "More actions" menu first
    await user.click(screen.getByLabelText('More actions'));
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('enters inline edit mode on desktop when an ex:edit-message event names this message and it is own', async () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ id: 'msg-7' })}
        authorName="Alice"
        isOwn={true}
        currentUserId="user-1"
      />,
    );
    expect(screen.queryByTestId('inline-edit')).not.toBeInTheDocument();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('ex:edit-message', { detail: { messageId: 'msg-7' } }),
      );
    });
    expect(await screen.findByTestId('inline-edit')).toBeInTheDocument();
  });

  it('asks the parent composer to edit on mobile instead of rendering inline', () => {
    const originalMatchMedia = window.matchMedia;
    setMobileMatch(true);
    try {
      const onEditMessage = vi.fn();
      const message = makeMessage({ id: 'msg-7' });
      renderWithProviders(
        <MessageItem
          message={message}
          authorName="Alice"
          isOwn={true}
          currentUserId="user-1"
          onEditMessage={onEditMessage}
        />,
      );
      act(() => {
        window.dispatchEvent(
          new CustomEvent('ex:edit-message', { detail: { messageId: 'msg-7' } }),
        );
      });
      expect(onEditMessage).toHaveBeenCalledWith(message);
      expect(screen.queryByTestId('inline-edit')).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
    }
  });

  it('does not handle edit events for other peoples messages', () => {
    const onEditMessage = vi.fn();
    renderWithProviders(
      <MessageItem
        message={makeMessage({ id: 'msg-7' })}
        authorName="Alice"
        isOwn={false}
        currentUserId="user-1"
        onEditMessage={onEditMessage}
      />,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent('ex:edit-message', { detail: { messageId: 'msg-7' } }),
      );
    });
    expect(onEditMessage).not.toHaveBeenCalled();
  });

  it('ignores ex:edit-message events for other messages', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ id: 'msg-7' })}
        authorName="Alice"
        isOwn={true}
        currentUserId="user-1"
      />,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent('ex:edit-message', { detail: { messageId: 'msg-other' } }),
      );
    });
    expect(screen.queryByTestId('inline-edit')).not.toBeInTheDocument();
  });

  it('does not show edit/delete buttons for other people\'s messages', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Bob"
        isOwn={false}
      />,
    );

    // The "More actions" menu is rendered for everyone now (Copy link
    // and Pin work on any message), but Edit/Delete remain own-only.
    expect(screen.getByLabelText('More actions')).toBeInTheDocument();
    // Mocked DropdownMenuContent renders all items inline — we check
    // by presence of the labels themselves.
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    // Pin and Copy link are still available.
    expect(screen.getByLabelText('Pin message')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy link to message')).toBeInTheDocument();
  });

  it('renders author initials in avatar', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice Johnson"
        isOwn={false}
      />,
    );

    expect(screen.getByText('AJ')).toBeInTheDocument();
  });

  it('renders reactions when present', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { '👍': ['user-1', 'user-2'], '🎉': ['user-3'] } })}
        authorName="Alice"
        isOwn={false}
        currentUserId="user-1"
      />,
    );
    const list = screen.getByRole('list', { name: /reactions/i });
    expect(list).toBeInTheDocument();
    expect(screen.getByText('👍')).toBeInTheDocument();
    expect(screen.getByText('🎉')).toBeInTheDocument();
  });

  it('shows reaction count', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { '👍': ['user-1', 'user-2', 'user-3'] } })}
        authorName="Alice"
        isOwn={false}
        currentUserId="user-1"
      />,
    );
    const reactionBtn = screen.getByRole('listitem');
    expect(reactionBtn).toHaveTextContent('👍');
    expect(reactionBtn).toHaveTextContent('3');
  });

  it('marks own reaction as pressed', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { '👍': ['user-1'] } })}
        authorName="Alice"
        isOwn={false}
        currentUserId="user-1"
      />,
    );
    expect(screen.getByRole('listitem')).toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking existing reaction toggles it', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    mockReactMutate.mockClear();
    renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { '👍': ['user-1'] } })}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    await user.click(screen.getByRole('listitem'));
    expect(mockReactMutate).toHaveBeenCalledWith({
      messageId: 'msg-1',
      emoji: '👍',
      channelId: 'channel-1',
      conversationId: undefined,
    });
  });

  it('opens emoji picker from reaction button and selecting an emoji calls toggle', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    mockReactMutate.mockClear();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    await user.click(screen.getByLabelText('Add reaction'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Picker opens on the first category; search to surface the generated
    // activity shortcode.
    await user.type(screen.getByLabelText('Search emojis'), 'tada');
    await user.click(screen.getByLabelText('React with :tada:'));
    expect(mockReactMutate).toHaveBeenCalledWith({
      messageId: 'msg-1',
      emoji: ':tada:',
      channelId: 'channel-1',
      conversationId: undefined,
    });
  });

  it('opens message actions from long press on touch pointers', async () => {
    const reply = vi.fn();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
        channelId="channel-1"
        currentUserId="user-1"
        onReplyInThread={reply}
      />,
    );
    const row = screen.getByTestId('message-actions-trigger').closest('[data-message-id]')!;
    act(() => {
      fireEvent.pointerDown(row, { pointerType: 'touch' });
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 430));
    });
    const sheet = screen.getByTestId('mobile-message-actions');
    const overlay = sheet.parentElement!;
    expect(sheet).toBeInTheDocument();
    expect(overlay).toHaveClass('select-none', '[-webkit-touch-callout:none]', '[-webkit-user-select:none]');
    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    overlay.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(within(sheet).getByRole('button', { name: 'Reply in thread' })).toHaveClass('h-12', 'w-full');
    expect(within(sheet).getByLabelText('Add reaction')).toBeInTheDocument();
    expect(within(sheet).getByLabelText('Pin message')).toBeInTheDocument();
    expect(within(sheet).getByText('Edit')).toBeInTheDocument();
    expect(within(sheet).getByText('Delete')).toBeInTheDocument();
  });

  it('keeps mobile long-press rows vertically pannable and suppresses native callout', () => {
    const originalMatchMedia = window.matchMedia;
    setMobileMatch(true);
    try {
      renderWithProviders(
        <MessageItem
          message={makeMessage()}
          authorName="Alice"
          isOwn={false}
          channelId="channel-1"
          currentUserId="user-1"
        />,
      );
      const row = screen.getByTestId('message-actions-trigger').closest('[data-message-id]')!;

      expect(row).toHaveClass('max-md:touch-pan-y', 'max-md:[-webkit-touch-callout:none]');
      const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      row.dispatchEvent(contextMenu);
      expect(contextMenu.defaultPrevented).toBe(true);
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
    }
  });

  it('closes mobile reaction overlays after picking an emoji', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    setMobileMatch(true);
    mockReactMutate.mockClear();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    const row = screen.getByTestId('message-actions-trigger').closest('[data-message-id]')!;
    act(() => {
      fireEvent.pointerDown(row, { pointerType: 'touch' });
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 430));
    });
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.touchAction).toBe('');
    expect(document.body.style.overscrollBehavior).toBe('');

    await user.click(within(screen.getByTestId('mobile-message-actions')).getByLabelText('Add reaction'));
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.touchAction).toBe('');
    expect(document.body.style.overscrollBehavior).toBe('');
    await user.type(screen.getByLabelText('Search emojis'), 'tada');
    await user.click(screen.getByLabelText('React with :tada:'));

    expect(mockReactMutate).toHaveBeenCalledWith({
      messageId: 'msg-1',
      emoji: ':tada:',
      channelId: 'channel-1',
      conversationId: undefined,
    });
    expect(screen.queryByTestId('mobile-message-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('popover-portal')).not.toBeInTheDocument();
    expect(document.querySelector('.fixed.inset-0')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.touchAction).toBe('');
    expect(document.body.style.overscrollBehavior).toBe('');

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true });
    row.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    const touchMove = new TouchEvent('touchmove', { bubbles: true, cancelable: true });
    row.dispatchEvent(touchMove);
    expect(touchMove.defaultPrevented).toBe(false);
  });

  it('does not render reactions row when no reactions', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
        currentUserId="user-1"
      />,
    );
    expect(screen.queryByRole('list', { name: /reactions/i })).not.toBeInTheDocument();
  });
});
