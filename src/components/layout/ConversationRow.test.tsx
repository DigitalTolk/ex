import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import type { UserConversation } from '@/types';
import { ConversationRow } from './ConversationRow';

const muteConversation = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useSidebar', () => ({
  useMuteConversation: () => ({ mutate: muteConversation }),
  useReorderSidebar: () => ({ mutate: vi.fn(), isPending: false }),
  markLocalSidebarReorder: vi.fn(),
  shouldRefetchSidebarForRemoteUpdate: vi.fn(() => true),
  resetSidebarReorderSessionState: vi.fn(),
  useFavoriteConversation: () => ({ mutate: vi.fn() }),
  useSetConversationCategory: () => ({ mutate: vi.fn() }),
  useCategories: () => ({ data: [] }),
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
      <ConversationRow onNavigate={vi.fn()}
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
  beforeEach(() => {
    muteConversation.mockReset();
  });

  // The long-press that opens the row's menu on a phone.
  function openMenu() {
    const row = screen.getByTestId('conversation-row-c-1');
    fireEvent.pointerDown(row, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(500);
    });
  }

  it("offers to mute a bot's chat, and asks for exactly that", () => {
    vi.useFakeTimers();
    try {
      renderRow({ conversation: dm({ displayName: 'Uptime Kuma', bot: true }) });
      // Not muted: an ordinary row, with no muted mark.
      expect(screen.queryByTestId('conv-muted-c-1')).toBeNull();
      expect(screen.getByText('Uptime Kuma')).not.toHaveClass('text-gray-500');
      openMenu();
      fireEvent.click(screen.getByTestId('conv-mute-c-1'));
      expect(screen.queryByText('Unmute Uptime Kuma')).toBeNull();
      expect(muteConversation).toHaveBeenCalledWith({ conversationID: 'c-1', muted: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a muted bot's chat and offers to unmute it", () => {
    vi.useFakeTimers();
    try {
      renderRow({ conversation: dm({ displayName: 'Uptime Kuma', bot: true, muted: true }) });
      expect(screen.getByTestId('conv-muted-c-1')).toHaveAccessibleName('Muted');
      expect(screen.getByText('Uptime Kuma')).toHaveClass('text-gray-500');
      openMenu();
      expect(screen.getByTestId('conv-mute-c-1')).toHaveTextContent('Unmute Uptime Kuma');
      fireEvent.click(screen.getByTestId('conv-mute-c-1'));
      expect(muteConversation).toHaveBeenCalledWith({ conversationID: 'c-1', muted: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never offers to mute a person's chat", () => {
    vi.useFakeTimers();
    try {
      renderRow();
      openMenu();
      expect(screen.getByText('Close conversation')).toBeInTheDocument();
      expect(screen.queryByTestId('conv-mute-c-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

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
