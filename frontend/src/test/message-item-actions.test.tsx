import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageItem } from '@/components/chat/MessageItem';
import type { Message } from '@/types';

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

// Controlled-open dropdown mock: forwards `open` and `onOpenChange` so
// tests can drive the menu's open state and observe whether the host
// component (MessageItem) closes it on mouseLeave.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({
    children,
    open,
    onOpenChange,
    modal,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (v: boolean) => void;
    modal?: boolean;
  }) => (
    <div
      data-testid="dropdown-root"
      data-open={open ? 'true' : 'false'}
      data-modal={modal === false ? 'false' : 'true'}
    >
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        return React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
          'data-open': open,
          'data-on-open-change': onOpenChange,
        });
      })}
    </div>
  ),
  DropdownMenuTrigger: ({
    children,
    ...props
  }: { children: React.ReactNode; [k: string]: unknown } & {
    'data-on-open-change'?: (v: boolean) => void;
  }) => {
    const { 'data-on-open-change': onOpenChange, ...rest } = props as Record<string, unknown> & {
      'data-on-open-change'?: (v: boolean) => void;
    };
    return (
      <button
        {...rest}
        onClick={() => onOpenChange?.(true)}
      >
        {children}
      </button>
    );
  },
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
    parentID: 'ch-1',
    authorID: 'u-1',
    body: 'hello',
    createdAt: '2026-04-24T10:30:00Z',
    ...overrides,
  };
}

describe('MessageItem - hover bar and avatar', () => {
  it('renders Reply in thread button regardless of isOwn', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
      />,
    );
    expect(screen.getByLabelText('Reply in thread')).toBeInTheDocument();
    expect(screen.getByLabelText('Add reaction')).toBeInTheDocument();
  });

  it('shows edit/delete only when isOwn (Pin and Copy link are always present)', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
      />,
    );
    // Menu remains accessible to everyone for Copy link / Pin actions.
    expect(screen.getByLabelText('More actions')).toBeInTheDocument();
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows edit/delete when isOwn', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );
    expect(screen.getByLabelText('More actions')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('calls onReplyInThread when reply button is clicked', () => {
    const onReplyInThread = vi.fn();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
        onReplyInThread={onReplyInThread}
      />,
    );
    fireEvent.click(screen.getByLabelText('Reply in thread'));
    expect(onReplyInThread).toHaveBeenCalledWith('msg-1');
  });

  it('renders without crashing when authorAvatarURL is provided', () => {
    // Radix Avatar's AvatarImage only mounts the <img> after onLoad fires,
    // so we can't reliably assert on the DOM in jsdom. Just make sure the
    // component renders with the prop set.
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        authorAvatarURL="https://example.com/a.png"
        isOwn={false}
      />,
    );
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows reply count link when replyCount > 0', () => {
    const onReplyInThread = vi.fn();
    renderWithProviders(
      <MessageItem
        message={makeMessage({ replyCount: 3 })}
        authorName="Alice"
        isOwn={false}
        onReplyInThread={onReplyInThread}
      />,
    );
    const replyLink = screen.getByText('3 replies');
    fireEvent.click(replyLink);
    expect(onReplyInThread).toHaveBeenCalledWith('msg-1');
  });

  it('shows singular "reply" when replyCount is 1', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ replyCount: 1 })}
        authorName="Alice"
        isOwn={false}
      />,
    );
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });

  it('closes an open kebab menu when another message row gets hovered', () => {
    // Bug: clicking "..." opened the menu and pinned the toolbar, but
    // moving the mouse to a different message left the toolbar stuck on
    // the original row because the dropdown was still open. The fix
    // listens for mouseEnter on every row and closes any other open
    // menu — so hovering message B drops message A's menu instantly.
    renderWithProviders(
      <>
        <MessageItem message={makeMessage({ id: 'msg-a' })} authorName="Alice" isOwn={false} />
        <MessageItem message={makeMessage({ id: 'msg-b' })} authorName="Bob" isOwn={false} />
      </>,
    );
    const triggerA = screen.getAllByTestId('message-actions-trigger')[0];
    fireEvent.click(triggerA);
    const rootA = triggerA.closest('[data-testid="dropdown-root"]') as HTMLElement;
    expect(rootA.getAttribute('data-open')).toBe('true');

    // Hover the second message — A's menu must close.
    const rowB = document.querySelector('[data-message-id="msg-b"]') as HTMLElement;
    fireEvent.mouseEnter(rowB);
    expect(rootA.getAttribute('data-open')).toBe('false');
  });

  it('does not close the menu when the same message gets re-hovered', () => {
    // Re-entering the same row (e.g. cursor wiggle) must not cancel the
    // user's open menu — only a different message ID counts as "moved
    // somewhere else".
    renderWithProviders(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} />,
    );
    const trigger = screen.getByTestId('message-actions-trigger');
    fireEvent.click(trigger);
    const root = trigger.closest('[data-testid="dropdown-root"]') as HTMLElement;
    expect(root.getAttribute('data-open')).toBe('true');

    const row = trigger.closest('[data-message-id]') as HTMLElement;
    fireEvent.mouseEnter(row);
    expect(root.getAttribute('data-open')).toBe('true');
  });

  it('toolbar starts hidden when the row is not hovered', () => {
    renderWithProviders(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} />,
    );
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Message actions"]') as HTMLElement;
    expect(toolbar.getAttribute('data-actions-visible')).toBe('false');
    expect(toolbar.style.opacity).toBe('0');
  });

  it('shows the toolbar on row mouseEnter and hides it on mouseLeave', () => {
    renderWithProviders(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} />,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Message actions"]') as HTMLElement;
    fireEvent.mouseEnter(row);
    expect(toolbar.getAttribute('data-actions-visible')).toBe('true');
    expect(toolbar.style.opacity).toBe('1');
    fireEvent.mouseLeave(row);
    expect(toolbar.getAttribute('data-actions-visible')).toBe('false');
    expect(toolbar.style.opacity).toBe('0');
  });

  it('keeps the toolbar visible after clicking "..." even though the cursor may stop firing :hover', () => {
    // Bug: clicking the kebab made the toolbar vanish instantly because
    // Radix's open dropdown changes pointer-events / focus management,
    // which broke Tailwind group-hover. The fix tracks visibility in
    // JS state (visible = hovered || actionsMenuOpen) and renders an
    // inline opacity style — no CSS variants in the critical path.
    renderWithProviders(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} />,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByTestId('message-actions-trigger'));
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Message actions"]') as HTMLElement;
    expect(toolbar.getAttribute('data-actions-pinned')).toBe('true');
    expect(toolbar.getAttribute('data-actions-visible')).toBe('true');
    expect(toolbar.style.opacity).toBe('1');

    // The cursor leaving the row (e.g. moving to the menu portal) must
    // NOT hide the toolbar while the menu is open.
    fireEvent.mouseLeave(row);
    expect(toolbar.getAttribute('data-actions-visible')).toBe('true');
    expect(toolbar.style.opacity).toBe('1');
  });

  it('renders the kebab DropdownMenu with modal={false}', () => {
    // Regression: with modal={true} (the default), Radix shields the
    // rest of the page with pointer-events:none while the menu is
    // open, which (a) breaks the row's own hover state, and (b)
    // prevents mouseEnter from firing on other message rows —
    // defeating the singleton listener that's supposed to close the
    // menu when the user hovers elsewhere.
    renderWithProviders(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn={false} />,
    );
    const root = screen.getByTestId('dropdown-root');
    expect(root.getAttribute('data-modal')).toBe('false');
  });

  it('hovering another message hides the original toolbar AND closes its menu', () => {
    // Full bug reproduction: open the menu on A, then hover B. A's
    // menu must close, A's pin must clear, and A's toolbar must
    // disappear (because actionsMenuOpen=false AND hovered=false).
    renderWithProviders(
      <>
        <MessageItem message={makeMessage({ id: 'msg-a' })} authorName="Alice" isOwn={false} />
        <MessageItem message={makeMessage({ id: 'msg-b' })} authorName="Bob" isOwn={false} />
      </>,
    );
    const rowA = document.querySelector('[data-message-id="msg-a"]') as HTMLElement;
    const rowB = document.querySelector('[data-message-id="msg-b"]') as HTMLElement;
    const toolbarA = rowA.querySelector('[role="toolbar"][aria-label="Message actions"]') as HTMLElement;
    const triggerA = rowA.querySelector('[data-testid="message-actions-trigger"]') as HTMLElement;

    fireEvent.mouseEnter(rowA);
    fireEvent.click(triggerA);
    expect(toolbarA.getAttribute('data-actions-visible')).toBe('true');
    expect(toolbarA.getAttribute('data-actions-pinned')).toBe('true');

    // Hover B — A's menu and toolbar both clear.
    fireEvent.mouseEnter(rowB);
    expect(toolbarA.getAttribute('data-actions-pinned')).toBe('false');
    expect(toolbarA.getAttribute('data-actions-visible')).toBe('false');
    expect(toolbarA.style.opacity).toBe('0');
  });

  it('the closed-toolbar style cannot be re-shown by hovering another message (no resurrection)', () => {
    // Full reproduction of the user-reported "reappears when I hover
    // another message" bug. After A's menu closes, hovering B many
    // times must not bring A's toolbar back.
    renderWithProviders(
      <>
        <MessageItem message={makeMessage({ id: 'msg-a' })} authorName="Alice" isOwn={false} />
        <MessageItem message={makeMessage({ id: 'msg-b' })} authorName="Bob" isOwn={false} />
      </>,
    );
    const rowA = document.querySelector('[data-message-id="msg-a"]') as HTMLElement;
    const rowB = document.querySelector('[data-message-id="msg-b"]') as HTMLElement;
    const toolbarA = rowA.querySelector('[role="toolbar"][aria-label="Message actions"]') as HTMLElement;

    fireEvent.mouseEnter(rowA);
    fireEvent.click(rowA.querySelector('[data-testid="message-actions-trigger"]')!);
    fireEvent.mouseEnter(rowB);
    // Multiple hovers / leaves on B should never resurrect A's toolbar.
    for (let i = 0; i < 3; i++) {
      fireEvent.mouseLeave(rowB);
      fireEvent.mouseEnter(rowB);
    }
    expect(toolbarA.getAttribute('data-actions-visible')).toBe('false');
    expect(toolbarA.style.opacity).toBe('0');
  });
});
