import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import type { UserConversation } from '@/types';
import { ConversationRow } from './ConversationRow';

vi.mock('@/hooks/useSidebar', () => ({
  useReorderSidebar: () => ({ mutate: vi.fn(), isPending: false }),
  markLocalSidebarReorder: vi.fn(),
  shouldRefetchSidebarForRemoteUpdate: vi.fn(() => true),
  resetSidebarReorderSessionState: vi.fn(),
  useFavoriteConversation: () => ({ mutate: vi.fn() }),
  useSetConversationCategory: () => ({ mutate: vi.fn() }),
}));
// Force the mobile branch so the long-press → controlled-menu path is exercised.
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => true }));
vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

function dm(over: Partial<UserConversation> = {}): UserConversation {
  return {
    conversationID: 'c-1',
    type: 'dm',
    displayName: 'Alice',
    favorite: false,
    ...over,
  } as UserConversation;
}

function renderRow(props: Partial<Parameters<typeof ConversationRow>[0]> = {}) {
  return render(
    <BrowserRouter>
      <ConversationRow
        conversation={dm()}
        hasUnread={false}
        onClose={vi.fn()}
        onHide={vi.fn()}
        {...props}
      />
    </BrowserRouter>,
  );
}

describe('ConversationRow', () => {
  it('suppresses navigation and notifies when suppressNavigation is set', () => {
    const onClose = vi.fn();
    const onSuppressNavigationConsumed = vi.fn();
    renderRow({ suppressNavigation: true, onClose, onSuppressNavigationConsumed });
    const link = screen.getByTestId('conversation-row-c-1').querySelector('a')!;
    fireEvent.click(link);
    expect(onSuppressNavigationConsumed).toHaveBeenCalledTimes(1);
    // Navigation suppressed → onClose is NOT invoked.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose on a normal click', () => {
    const onClose = vi.fn();
    renderRow({ onClose });
    const link = screen.getByTestId('conversation-row-c-1').querySelector('a')!;
    fireEvent.click(link);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('falls back to "??" for a DM with an empty display name', () => {
    const { container } = renderRow({ conversation: dm({ displayName: '' }) });
    const fallback = container.querySelector('[data-slot="avatar-fallback"]');
    expect(fallback?.textContent).toBe('?');
  });

  it('opens the menu on a mobile long-press and swallows the follow-up nav click', () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      renderRow({ onClose });
      const row = screen.getByTestId('conversation-row-c-1');
      fireEvent.pointerDown(row, { pointerType: 'touch' });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByText('Close conversation')).toBeInTheDocument();
      fireEvent.pointerUp(row, { pointerType: 'touch' });
      fireEvent.click(screen.getByTestId('conversation-row-c-1').querySelector('a')!);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
