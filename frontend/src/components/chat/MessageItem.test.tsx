import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

const mockEditMutate = vi.fn();
const mockDeleteMutate = vi.fn();
const mockReactMutate = vi.fn();

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: mockEditMutate, isPending: false }),
  useDeleteMessage: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useToggleReaction: () => ({ mutate: mockReactMutate, isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
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

  it('enters edit mode when an ex:edit-message event names this message and it is own', async () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ id: 'msg-7' })}
        authorName="Alice"
        isOwn={true}
        currentUserId="user-1"
      />,
    );
    expect(screen.queryByTestId('inline-edit')).not.toBeInTheDocument();
    // Wrap the synchronous state update from the listener so vitest
    // doesn't surface an act() warning — dispatchEvent on window fires
    // listeners synchronously and one of them calls setIsEditing.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('ex:edit-message', { detail: { messageId: 'msg-7' } }),
      );
    });
    expect(await screen.findByTestId('inline-edit')).toBeInTheDocument();
  });

  it('scrolls the message into view when entering edit mode (so the inline edit isn\'t hidden behind the composer when editing the last message)', async () => {
    // Regression: the composer sits below the scroll container. When
    // the user edits the bottom-most message, the inline edit grows
    // past the previous max-scroll and ends up clipped behind the
    // composer. Mounting an editor must call scrollIntoView so the
    // browser brings it back into view.
    const original = Element.prototype.scrollIntoView;
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
    try {
      renderWithProviders(
        <MessageItem
          message={makeMessage({ id: 'msg-9' })}
          authorName="Alice"
          isOwn={true}
          currentUserId="user-1"
        />,
      );
      act(() => {
        window.dispatchEvent(
          new CustomEvent('ex:edit-message', { detail: { messageId: 'msg-9' } }),
        );
      });
      await screen.findByTestId('inline-edit');
      // Two rAF frames are queued by the effect — flush them.
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      expect(spy).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('focuses the inline editor after entering edit mode via ex:edit-message', async () => {
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
        new CustomEvent('ex:edit-message', { detail: { messageId: 'msg-7' } }),
      );
    });
    await screen.findByTestId('inline-edit');
    // MessageInput's focusKey effect runs on mount and queues a
    // editor.focus() in a microtask — wait for it to land. In jsdom
    // Lexical's contenteditable becomes the active element.
    const editor = await screen.findByLabelText('Message input');
    await waitFor(() => {
      expect(document.activeElement).toBe(editor);
    });
  });

  it('dispatches ex:focus-composer when an inline edit is cancelled', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const events: Array<{ parentID?: string; inThread?: boolean }> = [];
    const listener = (e: Event) => {
      const ce = e as CustomEvent<{ parentID?: string; inThread?: boolean }>;
      if (ce.detail) events.push(ce.detail);
    };
    window.addEventListener('ex:focus-composer', listener);
    renderWithProviders(
      <MessageItem
        message={makeMessage({ id: 'msg-7', parentID: 'ch-1' })}
        authorName="Alice"
        isOwn={true}
        currentUserId="user-1"
      />,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent('ex:edit-message', { detail: { messageId: 'msg-7' } }),
      );
    });
    await screen.findByTestId('inline-edit');
    // Cancel the edit via the X button — onCancel routes through
    // endEdit() which dispatches the focus-return event. The X
    // button is the cancel control rendered by inline MessageInput.
    await user.click(screen.getByLabelText('Cancel'));
    window.removeEventListener('ex:focus-composer', listener);
    expect(events).toEqual([{ parentID: 'ch-1', inThread: false }]);
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
    await user.click(screen.getByLabelText('React with :tada:'));
    expect(mockReactMutate).toHaveBeenCalledWith({
      messageId: 'msg-1',
      emoji: ':tada:',
      channelId: 'channel-1',
      conversationId: undefined,
    });
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
