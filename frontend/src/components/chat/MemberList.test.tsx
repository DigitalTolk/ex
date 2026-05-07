import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberList } from './MemberList';
import type { ChannelMembership } from '@/types';

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

function makeMember(overrides: Partial<ChannelMembership> = {}): ChannelMembership {
  return {
    channelID: 'ch-1',
    userID: 'user-1',
    role: 'member',
    displayName: 'Alice Johnson',
    joinedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

function touchSwipe(element: Element, fromX: number, toX: number, y = 160) {
  fireEvent.touchStart(element, { touches: [{ clientX: fromX, clientY: y }] });
  fireEvent.touchMove(element, { touches: [{ clientX: toX, clientY: y + 8 }] });
  fireEvent.touchEnd(element, { changedTouches: [{ clientX: toX, clientY: y + 8 }] });
}

function touchDrag(element: Element, fromX: number, toX: number, y = 160) {
  fireEvent.touchStart(element, { touches: [{ clientX: fromX, clientY: y }] });
  fireEvent.touchMove(element, { touches: [{ clientX: toX, clientY: y + 8 }] });
}

describe('MemberList', () => {
  it('renders all members', () => {
    const members = [
      makeMember({ userID: 'u1', displayName: 'Alice' }),
      makeMember({ userID: 'u2', displayName: 'Bob' }),
      makeMember({ userID: 'u3', displayName: 'Charlie' }),
    ];

    renderWithProviders(<MemberList members={members} />);

    const scrollArea = screen.getByTestId('member-list-scroll-area');
    const panel = scrollArea.parentElement!;
    expect(panel).toHaveClass(
      'w-80',
      'max-md:fixed',
      'max-md:inset-x-0',
      'max-md:top-[calc(2.75rem+env(safe-area-inset-top))]',
      'max-md:w-auto',
    );
    expect(scrollArea).toHaveClass('min-h-0', 'flex-1');
    expect(scrollArea.querySelector('[data-slot="scroll-area-scrollbar"]')).toHaveClass(
      'opacity-0',
      'data-[scrolling]:opacity-100',
    );
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Charlie')).toBeInTheDocument();
  });

  it('shows member count', () => {
    const members = [
      makeMember({ userID: 'u1', displayName: 'Alice' }),
      makeMember({ userID: 'u2', displayName: 'Bob' }),
    ];

    renderWithProviders(<MemberList members={members} />);

    expect(screen.getByText('2 members')).toBeInTheDocument();
  });

  it('does not close on a mobile right-to-left swipe', () => {
    const onClose = vi.fn();
    renderWithProviders(<MemberList members={[makeMember()]} onClose={onClose} />);

    const panel = screen.getByTestId('member-list-scroll-area').parentElement!;
    expect(panel).toHaveClass('mobile-right-sidebar-enter');
    touchSwipe(panel, 240, 120);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a mobile left-to-right swipe', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    renderWithProviders(<MemberList members={[makeMember()]} onClose={onClose} />);

    const panel = screen.getByTestId('member-list-scroll-area').parentElement!;
    touchSwipe(panel, 120, 240);

    expect(panel).toHaveAttribute('data-swipe-dismissing', 'true');
    expect(panel).toHaveClass('max-md:translate-x-full');
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(180));
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('tracks the finger while the mobile member list is being pulled closed', () => {
    const onClose = vi.fn();
    renderWithProviders(<MemberList members={[makeMember()]} onClose={onClose} />);

    const panel = screen.getByTestId('member-list-scroll-area').parentElement!;
    touchDrag(panel, 120, 190);

    expect(panel).toHaveStyle({ transform: 'translateX(70px)', transition: 'none' });
    expect(panel).toHaveAttribute('data-swipe-dismissing', 'false');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows singular "member" for count of 1', () => {
    renderWithProviders(<MemberList members={[makeMember()]} />);

    expect(screen.getByText('1 member')).toBeInTheDocument();
  });

  it('shows Owner badge for owner role string', () => {
    renderWithProviders(
      <MemberList
        members={[makeMember({ role: 'owner', displayName: 'Admin User' })]}
      />,
    );

    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('shows Admin badge for admin role string', () => {
    renderWithProviders(
      <MemberList
        members={[makeMember({ role: 'admin', displayName: 'Mod User' })]}
      />,
    );

    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('handles numeric role 3 as Owner', () => {
    renderWithProviders(
      <MemberList
        members={[makeMember({ role: 3 as unknown as ChannelMembership['role'], displayName: 'Owner User' })]}
      />,
    );

    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('handles numeric role 2 as Admin', () => {
    renderWithProviders(
      <MemberList
        members={[makeMember({ role: 2 as unknown as ChannelMembership['role'], displayName: 'Admin User' })]}
      />,
    );

    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('does not show badge for regular member role', () => {
    renderWithProviders(
      <MemberList
        members={[makeMember({ role: 'member', displayName: 'Regular User' })]}
      />,
    );

    expect(screen.queryByText('Owner')).not.toBeInTheDocument();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('shows initials in avatar', () => {
    renderWithProviders(
      <MemberList
        members={[makeMember({ displayName: 'Alice Johnson' })]}
      />,
    );

    expect(screen.getByText('AJ')).toBeInTheDocument();
  });

  it('renders user status after the username instead of with the avatar', () => {
    renderWithProviders(
      <MemberList
        members={[makeMember({ userID: 'u1', displayName: 'Alice Johnson' })]}
        userMap={{
          u1: {
            displayName: 'Alice Johnson',
            userStatus: { emoji: '☕', text: 'Coffee break' },
          },
        }}
      />,
    );

    const status = screen.getByLabelText(/Coffee break/);
    const nameStatus = screen.getByTestId('member-name-status-u1');
    const initials = screen.getByText('AJ');

    expect(nameStatus).toContainElement(status);
    expect(initials.closest('.relative')).not.toContainElement(status);
  });

  it('keeps member remove controls available on touch devices', () => {
    renderWithProviders(
      <MemberList
        channelId="ch-1"
        currentUserId="owner"
        currentUserRole={3}
        members={[makeMember({ userID: 'u1', role: 'member', displayName: 'Alice Johnson' })]}
      />,
    );

    expect(screen.getByLabelText('Remove Alice Johnson')).toHaveClass(
      'h-9',
      'w-9',
      'opacity-100',
      'md:opacity-0',
    );
  });

  it('shows "Members" heading', () => {
    renderWithProviders(<MemberList members={[makeMember()]} />);

    expect(screen.getByText('Members')).toBeInTheDocument();
  });
});
