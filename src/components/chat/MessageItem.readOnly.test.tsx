import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

const mockEditMutate = vi.fn();
const mockDeleteMutate = vi.fn();
const mockToggleReactionMutate = vi.fn();

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: mockEditMutate, isPending: false }),
  useDeleteMessage: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useToggleReaction: () => ({ mutate: mockToggleReactionMutate, isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), data: [] }),
}));

// Mock the dropdown menu so menu items render directly in jsdom
// Inline (not the shared __mocks__): this suite asserts on the MOBILE action
// sheet's "Copy message text" button by accessible name, so the desktop menu
// items must NOT also carry that aria-label (which the shared mock adds).
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children, ...rest }: { children: React.ReactNode; [k: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void; variant?: string }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
  // The hover toolbar mounts on hover (MessageItem): hover the row so the
  // tests can reach its actions the way a pointer user does.
  const row = result.container.querySelector('[data-message-id]');
  if (row) {
    fireEvent.pointerOver(row, { pointerType: 'mouse' });
    fireEvent.mouseEnter(row);
  }
  return result;
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

beforeEach(() => {
  vi.clearAllMocks();
  setMobileMatch(false);
});

afterEach(() => {
  vi.useRealTimers();
});

// An archived channel's messages are read-only: copy, mark unread and remind
// stay; reacting, replying, pinning, watching, editing and deleting go.
describe('MessageItem - read-only (archived channel)', () => {
  it('desktop: offers only non-modifying actions and shows reactions without toggling them', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { '👍': ['user-2'] } })}
        authorName="Alice"
        isOwn={true}
        channelId="ch-1"
        currentUserId="user-1"
        quickReactions={['👍', '🎉']}
        onReplyInThread={vi.fn()}
        readOnly
      />,
    );

    expect(screen.getByText('Copy link')).toBeInTheDocument();
    expect(screen.getByText('Mark as unread')).toBeInTheDocument();
    for (const label of ['Edit', 'Delete', 'Pin', 'Watch thread…']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByLabelText('Add reaction')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Reply in thread')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('React with 🎉')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add another reaction')).not.toBeInTheDocument();

    const chip = screen.getByTestId('reaction-badge');
    expect(chip).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(chip);
    expect(mockToggleReactionMutate).not.toHaveBeenCalled();
  });

  it('mobile: the action sheet has no reactions, reply, pin, edit or delete', () => {
    vi.useFakeTimers();
    setMobileMatch(true);
    renderWithProviders(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={true} channelId="ch-1" readOnly />,
    );
    const row = screen.getByTestId('message-actions-trigger').closest('[data-message-id]')!;
    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 20, clientY: 20 });
    act(() => {
      vi.advanceTimersByTime(430);
    });
    const sheet = screen.getByTestId('mobile-message-actions');
    expect(sheet).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-quick-reactions')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-primary-actions').className).toContain('grid-cols-3');
    expect(screen.getByLabelText('Copy link to message')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-mark-unread')).toBeInTheDocument();
    for (const name of ['Reply in thread', 'Pin message']) {
      expect(screen.queryByLabelText(name)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });
});
