import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import { WINDOW_EVENTS } from '@/lib/window-events';
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

async function openMobileActions(message: Message = makeMessage()) {
  vi.useFakeTimers();
  setMobileMatch(true);
  renderWithProviders(
    <MessageItem
      message={message}
      authorName="Alice"
      isOwn={true}
      channelId="ch-1"
    />,
  );
  const row = screen.getByTestId('message-actions-trigger').closest('[data-message-id]')!;
  fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 20, clientY: 20 });
  act(() => {
    vi.advanceTimersByTime(430);
  });
  expect(screen.getByTestId('mobile-message-actions')).toBeInTheDocument();
  vi.useRealTimers();
}

beforeEach(() => {
  vi.clearAllMocks();
  setMobileMatch(false);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MessageItem - editing', () => {
  it('enters inline edit mode on desktop when Edit is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );

    await user.click(screen.getByText('Edit'));

    expect(screen.getByLabelText('Message input').textContent).toContain('Hello world');
    expect(screen.getByLabelText('Save')).toBeInTheDocument();
    expect(screen.getByLabelText('Cancel')).toBeInTheDocument();
  });

  it('does not save unchanged inline edits', async () => {
    const user = userEvent.setup();
    const onFocusComposer = vi.fn();
    window.addEventListener(WINDOW_EVENTS.FocusComposer, onFocusComposer);
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );

    await user.click(screen.getByText('Edit'));
    await user.click(screen.getByLabelText('Save'));
    expect(mockEditMutate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Save')).toBeNull();
    expect(onFocusComposer).not.toHaveBeenCalled();
    window.removeEventListener(WINDOW_EVENTS.FocusComposer, onFocusComposer);
  });
});

describe('MessageItem - mobile actions', () => {
  it('opens a viewport-bounded bottom sheet for long-press actions', async () => {
    await openMobileActions();

    const sheet = screen.getByTestId('mobile-message-actions');
    expect(sheet.parentElement).toHaveClass('z-[120]');
    expect(sheet).toHaveClass('bottom-0', 'max-h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)]', 'overflow-y-auto');
    expect(sheet).toHaveClass('border-x-0', 'border-b-0');
  });

  it('offers copy text and suppresses native text selection affordances on mobile', async () => {
    await openMobileActions(makeMessage({ body: 'Copy this text' }));

    const row = screen.getByText('Copy this text').closest('[data-message-id]')!;
    expect(row).toHaveClass('max-md:select-none', 'max-md:[-webkit-user-select:none]', 'max-md:[-webkit-touch-callout:none]');
    await userEvent.click(screen.getByRole('button', { name: /Copy message text/i }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Copy this text');
    });
  });

  it('copies the raw markdown body (mention tokens intact) from the mobile copy action', async () => {
    await openMobileActions(makeMessage({ body: 'Hi @[u-2|Bob Jones] in ~[ch-1|general]' }));

    await userEvent.click(screen.getByRole('button', { name: /Copy message text/i }));

    await waitFor(() => {
      // Raw markdown so it round-trips into the composer (renders mention pills).
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Hi @[u-2|Bob Jones] in ~[ch-1|general]');
    });
  });

  it('makes the full reaction row clickable in the mobile action sheet', async () => {
    await openMobileActions();

    const sheet = screen.getByTestId('mobile-message-actions');
    const reaction = within(sheet).getByRole('button', { name: /Add reaction/i });
    expect(reaction).toHaveClass('w-full', 'gap-3');
    expect(reaction.querySelector('svg')).toBe(reaction.firstElementChild);
    await userEvent.click(reaction);

    expect(await screen.findByRole('dialog', { name: /Emoji picker/i })).toBeInTheDocument();
    expect(sheet).toHaveAttribute('data-actions-suppressed', 'true');
    expect(sheet).toHaveClass('hidden');
  });

  it('closes the mobile action sheet from the backdrop', async () => {
    await openMobileActions();
    expect(screen.getByTestId('mobile-message-actions')).toBeInTheDocument();
    // The swipe-to-dismiss drag is Motion-driven (unit-tested in
    // useSwipeDismiss.test); here we verify the backdrop close path.
    fireEvent.click(screen.getByLabelText('Close message actions'));
    await waitFor(() => expect(screen.queryByTestId('mobile-message-actions')).not.toBeInTheDocument());
  });

  it('does not open the mobile action sheet from a short tap', () => {
    vi.useFakeTimers();
    setMobileMatch(true);
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
        channelId="ch-1"
      />,
    );
    const row = screen.getByTestId('message-actions-trigger').closest('[data-message-id]')!;

    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window);
    vi.advanceTimersByTime(430);

    expect(screen.queryByTestId('mobile-message-actions')).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('MessageItem - delete', () => {
  it('opens a confirmation dialog and only deletes after confirm', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
        channelId="ch-1"
      />,
    );

    // Clicking the menu item alone must NOT delete — it opens the modal.
    await user.click(screen.getByText('Delete'));
    expect(mockDeleteMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('message-delete-confirm')).toBeInTheDocument();

    // Confirming fires the mutation.
    await user.click(screen.getByTestId('message-delete-confirm-confirm'));
    expect(mockDeleteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1', channelId: 'ch-1' }),
    );
  });

  it('Cancel keeps the message and closes the dialog', async () => {
    mockDeleteMutate.mockClear();
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
        channelId="ch-1"
      />,
    );

    await user.click(screen.getByText('Delete'));
    await user.click(screen.getByTestId('message-delete-confirm-cancel'));
    expect(mockDeleteMutate).not.toHaveBeenCalled();
  });
});

// Server-backed frequently-used shelf: stub so opening the picker never hits the network.
vi.mock('@/lib/emoji-frequency', () => ({
  EMOJI_FREQUENCY_CHANGED_EVENT: 'emoji-frequency-changed',
  getFrequentEmojis: vi.fn(async () => []),
  recordEmojiUse: vi.fn(async () => {}),
}));
