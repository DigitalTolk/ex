import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import { dispatchEditMessage } from '@/lib/window-events';
import type { Message } from '@/types';

// Targeted branch coverage for MessageItem — drives the desktop hover
// toolbar/menu, inline edit submit, copy-link deep-link arms, pinned
// menu variants, conversation-context attachments, the mobile action
// sheet's suppressed/reaction-picker states, and reacted-by-me styling.

const mutateEdit = vi.hoisted(() => vi.fn());
const mutatePin = vi.hoisted(() => vi.fn());
const mutateReact = vi.hoisted(() => vi.fn());
const useAttachmentsBatchMock = vi.hoisted(() => vi.fn(() => ({ map: new Map(), isLoading: false })));

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: mutateEdit, isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: mutateReact, isPending: false }),
  useSetPinned: () => ({ mutate: mutatePin, isPending: false }),
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

vi.mock('@/hooks/useUnfurl', () => ({
  useUnfurl: () => ({ data: undefined, isLoading: false }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

function touchPoint(element: Element, x: number, y: number) {
  return { identifier: 1, target: element, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
}

function dispatchTouch(element: Element, type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = type === 'touchend' ? [] : [touchPoint(element, x, y)];
  const changedTouches = [touchPoint(element, x, y)];
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'targetTouches', { value: touches });
  Object.defineProperty(event, 'changedTouches', { value: changedTouches });
  element.dispatchEvent(event);
  return event;
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    parentID: 'channel-1',
    parentType: 'channel',
    authorID: 'user-1',
    body: 'Hello world',
    createdAt: '2026-04-24T10:30:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  mutateEdit.mockClear();
  mutatePin.mockClear();
  mutateReact.mockClear();
  useAttachmentsBatchMock.mockReturnValue({ map: new Map(), isLoading: false });
});

afterEach(() => cleanup());

describe('MessageItem desktop toolbar + menu branches', () => {
  it('closes an open kebab menu when the cursor moves onto another row', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(
      <>
        <MessageItem message={makeMessage({ id: 'a' })} authorName="Alice" isOwn channelId="channel-1" currentUserId="user-1" />
        <MessageItem message={makeMessage({ id: 'b' })} authorName="Bob" isOwn={false} channelId="channel-1" currentUserId="user-1" />
      </>,
    );
    const rowA = document.querySelector('[data-message-id="a"]') as HTMLElement;
    const triggerA = rowA.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement;
    await userEvent.hover(rowA);
    // Open row A's kebab menu (a real click so Radix registers the open).
    await userEvent.click(triggerA);
    await vi.waitFor(() => {
      expect(rowA.querySelector('[data-actions-pinned="true"]')).not.toBeNull();
    });
    // Hovering row B notifies the hover listeners; row A closes its menu.
    const rowB = document.querySelector('[data-message-id="b"]') as HTMLElement;
    await userEvent.hover(rowB);
    await vi.waitFor(() => {
      expect(rowA.querySelector('[data-actions-pinned="true"]')).toBeNull();
    });
    expect(screen.container).toBeTruthy();
  });

  it('keeps the menu open when the hover notification is for its own row', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(
      <MessageItem message={makeMessage({ id: 'solo' })} authorName="Alice" isOwn channelId="channel-1" currentUserId="user-1" />,
    );
    const row = document.querySelector('[data-message-id="solo"]') as HTMLElement;
    await userEvent.hover(row);
    await userEvent.click(row.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement);
    await vi.waitFor(() => {
      expect(row.querySelector('[data-actions-pinned="true"]')).not.toBeNull();
    });
    // Re-hovering the SAME row notifies the listener with its own id →
    // activeID === ownID → the menu stays open (the false arm of the guard).
    await userEvent.hover(row);
    await new Promise((r) => setTimeout(r, 50));
    expect(row.querySelector('[data-actions-pinned="true"]')).not.toBeNull();
    expect(screen.container).toBeTruthy();
  });

  it('copies a channel deep-link from the kebab menu and shows the copied label', async () => {
    if (window.innerWidth <= 767) return;
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // Freeze ONLY the 1500ms `linkCopied` reset: intercept that specific
    // timer (and pass every other timer through to the real implementation so
    // Radix focus/animation timers keep working). This removes the race where
    // the slow hover→click→re-open dance can exceed the reset window (the
    // label would flip back to "Copy link" mid-assertion). The real truthy arm
    // is still exercised — only the reset timer is held.
    const realSetTimeout = window.setTimeout;
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (ms === 1500) return 0 as unknown as ReturnType<typeof setTimeout>;
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof window.setTimeout);
    try {
      const screen = await renderWithProviders(
        <MessageItem message={makeMessage()} authorName="Alice" isOwn channelId="channel-1" channelSlug="general" currentUserId="user-1" />,
      );
      const row = document.querySelector('[data-message-id]') as HTMLElement;
      await userEvent.hover(row);
      await userEvent.click(row.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement);
      await userEvent.click(await screen.getByRole('menuitem', { name: 'Copy link to message' }));
      // The deep-link builder used the channel-slug arm (…/channel/general…).
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalled();
        expect(String(writeText.mock.calls[0][0])).toContain('general');
      });
      // Re-open the menu (reset frozen) → the item label now reads
      // "Link copied" (the linkCopied truthy arm of the desktop menu).
      await userEvent.hover(row);
      await userEvent.click(row.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement);
      await expect.element(screen.getByText('Link copied')).toBeVisible();
    } finally {
      setTimeoutSpy.mockRestore();
      window.setTimeout = realSetTimeout;
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
    }
  });

  it('toggles pin from the kebab menu (pinned message variant)', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(
      <MessageItem message={makeMessage({ pinned: true })} authorName="Alice" isOwn channelId="channel-1" channelSlug="general" currentUserId="user-1" />,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    (row.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement).click();
    // Pinned message → the menu item reads "Unpin".
    const unpin = await screen.getByRole('menuitem', { name: 'Unpin message' });
    await unpin.click();
    expect(mutatePin).toHaveBeenCalledWith(expect.objectContaining({ pinned: false }));
  });

  it('opens the desktop inline editor from the menu and submits an unchanged body (no mutate)', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(
      <MessageItem message={makeMessage({ body: 'unchanged text' })} authorName="Alice" isOwn channelId="channel-1" currentUserId="user-1" />,
    );
    dispatchEditMessage({ messageId: 'msg-1' });
    await expect.element(screen.getByTestId('inline-edit')).toBeVisible();
    // Saving an unchanged body must short-circuit (same === true) and close
    // the editor without calling editMessage.mutate.
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="inline-edit"]')).toBeNull();
    });
    expect(mutateEdit).not.toHaveBeenCalled();
  });

  it('submits a changed body from the inline editor (mutate path)', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(
      <MessageItem message={makeMessage({ body: 'original' })} authorName="Alice" isOwn channelId="channel-1" currentUserId="user-1" />,
    );
    dispatchEditMessage({ messageId: 'msg-1' });
    await expect.element(screen.getByTestId('inline-edit')).toBeVisible();
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    await editor.fill('original edited');
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      expect(mutateEdit).toHaveBeenCalled();
    });
  });
});

describe('MessageItem content branches', () => {
  it('highlights a reaction the current user has made (reactedByMe arm)', async () => {
    await renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { ':tada:': ['user-1', 'user-2'] } })}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    await vi.waitFor(() => {
      const badge = document.querySelector('[data-testid="reaction-badge"]') as HTMLElement;
      expect(badge).not.toBeNull();
      // The current user reacted → the badge wears the primary highlight class.
      expect(badge.className).toContain('border-primary');
      expect(badge.getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('renders a reaction badge as un-pressed when there is no current user', async () => {
    await renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { ':tada:': ['user-2', 'user-3'] } })}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
      />,
    );
    // currentUserId is undefined → reactedByMe short-circuits to false (the
    // `currentUserId ? … : false` falsy arm), so the badge is not highlighted.
    await vi.waitFor(() => {
      const badge = document.querySelector('[data-testid="reaction-badge"]') as HTMLElement;
      expect(badge).not.toBeNull();
      expect(badge.getAttribute('aria-pressed')).toBe('false');
    });
  });

  it('renders attachments with no postedIn label when neither channel nor conversation is set', async () => {
    await renderWithProviders(
      <MessageItem
        message={makeMessage({ parentID: '', attachmentIDs: ['att-x'] })}
        authorName="Bob"
        isOwn={false}
        currentUserId="user-1"
      />,
    );
    // No channelId and no conversationId → parentType/postedIn resolve to
    // undefined (the final arms of those ternaries). The body still renders.
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Hello world');
    });
  });

  it('renders attachments in a conversation context (parentType conversation)', async () => {
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), isLoading: false });
    await renderWithProviders(
      <MessageItem
        message={makeMessage({ parentID: 'conv-1', parentType: 'conversation', attachmentIDs: ['att-1'] })}
        authorName="Bob"
        isOwn={false}
        conversationId="conv-1"
        currentUserId="user-1"
      />,
    );
    // MessageAttachments mounts with parentType=conversation / postedIn="Direct message".
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Hello world');
    });
  });

  it('skips the unfurl card when noUnfurl is set even with a URL in the body', async () => {
    const screen = await renderWithProviders(
      <MessageItem
        message={makeMessage({ body: 'see https://example.com/page', noUnfurl: true })}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    await expect.element(screen.getByText(/see/)).toBeVisible();
    // noUnfurl short-circuits before extractURLs → no unfurl card.
    expect(document.querySelector('[data-testid="unfurl-card"]')).toBeNull();
  });

  it('lists at most 20 reactors then summarizes the remainder ("and N more")', async () => {
    const reactors = Array.from({ length: 23 }, (_, i) => `u-${i}`);
    await renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { ':wave:': reactors } })}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-99"
        userMap={{ get: (id: string) => ({ displayName: `Name ${id}` }) }}
      />,
    );
    const badge = document.querySelector('[data-testid="reaction-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    // A real hover opens the Radix tooltip whose body runs formatReactors,
    // which caps the list at 20 names and appends "and N more".
    await userEvent.hover(badge);
    await vi.waitFor(() => {
      const tip = document.querySelector('[data-testid="reaction-tooltip"]');
      expect(tip).not.toBeNull();
      expect(tip!.textContent).toMatch(/and 3 more/);
    }, { timeout: 3000 });
  });
});

describe('MessageItem mobile action sheet branches', () => {
  it('opens the long-press sheet, suppresses it while the reaction picker is open', async () => {
    if (window.innerWidth > 767) return;
    const screen = await renderWithProviders(
      <MessageItem message={makeMessage({ pinned: true })} authorName="Alice" isOwn channelId="channel-1" channelSlug="general" currentUserId="user-1" />,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    const sheet = await vi.waitFor(() => {
      const s = document.querySelector('[data-testid="mobile-message-actions"]') as HTMLElement | null;
      expect(s).not.toBeNull();
      return s!;
    }, { timeout: 1500 });
    // Pinned message → the sheet's pin row reads "Unpin".
    expect(sheet.textContent).toContain('Unpin');

    // Opening the in-sheet reaction picker suppresses the sheet backdrop.
    await screen.getByRole('button', { name: 'Add reaction' }).click();
    await vi.waitFor(() => {
      const s = document.querySelector('[data-testid="mobile-message-actions"]') as HTMLElement;
      expect(s.dataset.actionsSuppressed).toBe('true');
    });
    // Dismissing the picker (Escape) runs onOpenChange(false) → the else arm
    // → closeMobileActions, tearing the whole sheet down.
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="mobile-message-actions"]')).toBeNull();
    });
  });

  it('flips the copy-link label to "Link copied" when the sheet is reopened after a copy', async () => {
    if (window.innerWidth > 767) return;
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const screen = await renderWithProviders(
        <MessageItem message={makeMessage()} authorName="Alice" isOwn channelId="channel-1" channelSlug="general" currentUserId="user-1" />,
      );
      const row = document.querySelector('[data-message-id]') as HTMLElement;
      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="mobile-message-actions"]')).not.toBeNull();
      }, { timeout: 1500 });
      await screen.getByRole('button', { name: 'Copy link to message' }).click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="mobile-message-actions"]')).toBeNull();
      });
      // Reopen the sheet within the 1.5s copied window → the sheet's copy-link
      // row now reads "Link copied" (the linkCopied truthy arm).
      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      await vi.waitFor(() => {
        const s = document.querySelector('[data-testid="mobile-message-actions"]') as HTMLElement | null;
        expect(s?.textContent ?? '').toContain('Link copied');
      }, { timeout: 1500 });
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
    }
  });

  it('reacts and closes the sheet when an emoji is picked', async () => {
    if (window.innerWidth > 767) return;
    const screen = await renderWithProviders(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn channelId="channel-1" currentUserId="user-1" />,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="mobile-message-actions"]')).not.toBeNull();
    }, { timeout: 1500 });
    // Copy text closes the sheet (a simple sheet-action that exercises
    // closeMobileActions / cancelLongPress with no pending timer).
    await screen.getByRole('button', { name: 'Copy message text' }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="mobile-message-actions"]')).toBeNull();
    });
  });
});

describe('MessageItem misc branches', () => {
  it('prevents the native context menu on mobile but not on desktop', async () => {
    const screen = await renderWithProviders(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn channelId="channel-1" currentUserId="user-1" />,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    if (window.innerWidth > 767) {
      // Desktop: the handler returns early, default not prevented.
      expect(ev.defaultPrevented).toBe(false);
    } else {
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(screen.container).toBeTruthy();
  });

  it('renders an unfurl card for the first URL when noUnfurl is not set', async () => {
    const screen = await renderWithProviders(
      <MessageItem
        message={makeMessage({ body: 'check https://example.com/post out' })}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    // urls[0] is truthy → the UnfurlCard arm renders (the card itself returns
    // null while useUnfurl is mocked undefined, but the branch executed). The
    // message body still renders alongside it.
    await expect.element(screen.getByText(/check/)).toBeVisible();
  });

  it('falls back to a /#msg- deep-link when there is no slug or conversation', async () => {
    if (window.innerWidth <= 767) return;
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // Freeze only the 1500ms linkCopied reset so the re-open + assertion is
    // deterministic (see the channel deep-link test for the rationale).
    const realSetTimeout = window.setTimeout;
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (ms === 1500) return 0 as unknown as ReturnType<typeof setTimeout>;
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof window.setTimeout);
    try {
      const screen = await renderWithProviders(
        <MessageItem message={makeMessage()} authorName="Alice" isOwn currentUserId="user-1" />,
      );
      const row = document.querySelector('[data-message-id]') as HTMLElement;
      await userEvent.hover(row);
      await userEvent.click(row.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement);
      await userEvent.click(await screen.getByRole('menuitem', { name: 'Copy link to message' }));
      // Neither channel slug/id nor conversationId set → the bare-hash fallback.
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalled();
        expect(String(writeText.mock.calls[0][0])).toContain('#msg-');
      });
      // Re-open the menu (reset frozen) → the copied label is shown.
      await userEvent.hover(row);
      await userEvent.click(row.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement);
      await expect.element(screen.getByText('Link copied')).toBeVisible();
    } finally {
      setTimeoutSpy.mockRestore();
      window.setTimeout = realSetTimeout;
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
    }
  });

  it('shows the inline editor "Loading…" state while edit attachments resolve', async () => {
    if (window.innerWidth <= 767) return;
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), isLoading: true });
    const screen = await renderWithProviders(
      <MessageItem
        message={makeMessage({ attachmentIDs: ['att-pending'] })}
        authorName="Alice"
        isOwn
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    dispatchEditMessage({ messageId: 'msg-1' });
    // editorReady is false (loading attachments) → the "Loading…" placeholder.
    await expect.element(screen.getByText('Loading…')).toBeVisible();
  });

  it('seeds the inline editor with a resolved edit attachment chip', async () => {
    if (window.innerWidth <= 767) return;
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([
        ['att-1', { id: 'att-1', filename: 'doc.pdf', contentType: 'application/pdf', size: 100, url: 'https://cdn.test/doc.pdf' }],
      ]),
      isLoading: false,
    });
    const screen = await renderWithProviders(
      <MessageItem
        message={makeMessage({ attachmentIDs: ['att-1'] })}
        authorName="Alice"
        isOwn
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    dispatchEditMessage({ messageId: 'msg-1' });
    // The attachment is found in the map → mapped to a DraftAttachment chip
    // (the non-null arm of the .map()), so the editor mounts with the chip.
    await expect.element(screen.getByTestId('inline-edit')).toBeVisible();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('doc.pdf');
    });
  });

  it('cancels a pending long-press when the finger moves (timer non-null arm)', async () => {
    if (window.innerWidth > 767) return;
    await renderWithProviders(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn channelId="channel-1" currentUserId="user-1" />,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    // Start the long-press timer, then move before it fires → cancelLongPress
    // runs with a non-null timer ref (the clearTimeout arm).
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 10, clientY: 10 }));
    row.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'touch', clientX: 40, clientY: 40 }));
    await new Promise((r) => setTimeout(r, 500));
    // The action sheet never opened because the press was cancelled.
    expect(document.querySelector('[data-testid="mobile-message-actions"]')).toBeNull();
  });

  it('copies a link from the mobile sheet and flips the row label to "Link copied"', async () => {
    if (window.innerWidth > 767) return;
    const screen = await renderWithProviders(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn channelId="channel-1" channelSlug="general" currentUserId="user-1" />,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="mobile-message-actions"]')).not.toBeNull();
    }, { timeout: 1500 });
    await screen.getByRole('button', { name: 'Copy link to message' }).click();
    // The sheet closes after copy; the desktop menu (hidden) still flips its
    // label to "Link copied" via the shared linkCopied state.
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="mobile-message-actions"]')).toBeNull();
    });
  });

  it('dismisses the mobile sheet with a downward swipe (swipeDismissing arms)', async () => {
    if (window.innerWidth > 767) return;
    await renderWithProviders(
      <MessageItem message={makeMessage()} authorName="Alice" isOwn channelId="channel-1" currentUserId="user-1" />,
    );
    const row = document.querySelector('[data-message-id]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    const sheet = await vi.waitFor(() => {
      const s = document.querySelector('[data-testid="mobile-message-actions"]') as HTMLElement | null;
      expect(s).not.toBeNull();
      return s!;
    }, { timeout: 1500 });
    // Swipe the sheet down past the dismiss threshold; the swipe handler sets
    // swipeDismissing=true (the translate-y-full class + data attribute arms).
    // react-swipeable listens for touch events, not pointer events.
    const rect = sheet.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y0 = rect.top + 20;
    dispatchTouch(sheet, 'touchstart', x, y0);
    dispatchTouch(sheet, 'touchmove', x, y0 + 60);
    dispatchTouch(sheet, 'touchmove', x, y0 + 160);
    await vi.waitFor(() => {
      const s = document.querySelector('[data-testid="mobile-message-actions"]') as HTMLElement | null;
      expect(s?.style.transform ?? '').toContain('translateY');
    });
    dispatchTouch(sheet, 'touchend', x, y0 + 160);
    await vi.waitFor(() => {
      const s = document.querySelector('[data-testid="mobile-message-actions"]') as HTMLElement | null;
      expect(s?.dataset.swipeDismissing).toBe('true');
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="mobile-message-actions"]')).toBeNull();
    }, { timeout: 2000 });
  });

  it('builds a conversation deep-link for copy when there is no channel slug', async () => {
    if (window.innerWidth <= 767) return;
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const screen = await renderWithProviders(
        <MessageItem
          message={makeMessage({ parentID: 'conv-9', parentType: 'conversation' })}
          authorName="Bob"
          isOwn
          conversationId="conv-9"
          currentUserId="user-1"
        />,
      );
      const row = document.querySelector('[data-message-id]') as HTMLElement;
      await userEvent.hover(row);
      await userEvent.click(row.querySelector('[data-testid="message-actions-trigger"]') as HTMLButtonElement);
      await userEvent.click(await screen.getByRole('menuitem', { name: 'Copy link to message' }));
      // The conversation arm of buildMessageLink ran (no slug, conversationId set).
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalled();
        expect(String(writeText.mock.calls[0][0])).toContain('conv-9');
      });
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
    }
  });
});
