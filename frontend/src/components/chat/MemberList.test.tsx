import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberList } from './MemberList';
import type { ChannelMembership } from '@/types';

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

describe('MemberList', () => {
  it('renders all members', () => {
    const members = [
      makeMember({ userID: 'u1', displayName: 'Alice' }),
      makeMember({ userID: 'u2', displayName: 'Bob' }),
      makeMember({ userID: 'u3', displayName: 'Charlie' }),
    ];

    renderWithProviders(<MemberList members={members} />);

    const scrollArea = screen.getByTestId('member-list-scroll-area');
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

  it('shows "Members" heading', () => {
    renderWithProviders(<MemberList members={[makeMember()]} />);

    expect(screen.getByText('Members')).toBeInTheDocument();
  });
});
