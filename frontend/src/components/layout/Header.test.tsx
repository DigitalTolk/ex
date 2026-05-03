import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { Header } from './Header';
import type { Channel } from '@/types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    name: 'general',
    slug: 'general',
    type: 'public',
    createdBy: 'user-1',
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderHeaderWithProviders(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('Header', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({});
  });

  it('renders channel name', () => {
    render(<Header channel={makeChannel({ name: 'general' })} />);

    expect(screen.getByText('general')).toBeInTheDocument();
  });

  it('shows hash icon for public channels', () => {
    render(<Header channel={makeChannel({ type: 'public' })} />);

    expect(screen.getByLabelText('Public channel')).toBeInTheDocument();
  });

  it('shows lock icon for private channels', () => {
    render(<Header channel={makeChannel({ type: 'private' })} />);

    expect(screen.getByLabelText('Private channel')).toBeInTheDocument();
    expect(screen.queryByLabelText('Public channel')).not.toBeInTheDocument();
  });

  it('shows member count badge', () => {
    render(
      <Header
        channel={makeChannel()}
        memberCount={42}
      />,
    );

    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('member count is clickable', async () => {
    const user = userEvent.setup();
    const onMembersClick = vi.fn();

    render(
      <Header
        channel={makeChannel()}
        memberCount={5}
        onMembersClick={onMembersClick}
      />,
    );

    await user.click(screen.getByLabelText('Toggle member list'));

    expect(onMembersClick).toHaveBeenCalledTimes(1);
  });

  it('does not show member badge when memberCount is undefined', () => {
    render(<Header channel={makeChannel()} />);

    expect(screen.queryByLabelText('Toggle member list')).not.toBeInTheDocument();
  });

  it('renders title when no channel is provided', () => {
    render(<Header title="Direct Message" />);

    expect(screen.getByText('Direct Message')).toBeInTheDocument();
    // No hash or lock icon when no channel
    expect(screen.queryByLabelText('Public channel')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Private channel')).not.toBeInTheDocument();
  });

  it('shows channel description when present', () => {
    render(
      <Header
        channel={makeChannel({ description: 'General discussion' })}
      />,
    );

    expect(screen.getByText('General discussion')).toBeInTheDocument();
  });

  it('renders the fallback avatar with initials when showAvatar is true and avatarURL is missing', () => {
    const { container } = render(<Header title="Alice" showAvatar />);
    const fallback = container.querySelector('[data-slot="avatar-fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toBe('A');
  });

  it('omits the avatar slot when showAvatar is false (group conversations)', () => {
    const { container } = render(<Header title="Alice, Bob" />);
    expect(container.querySelector('[data-slot="avatar"]')).toBeNull();
  });

  it('renders the avatar image when showAvatar is true and avatarURL is provided', () => {
    const { container } = render(
      <Header title="Alice" showAvatar avatarURL="https://example.com/a.png" />,
    );
    expect(container.querySelector('[data-slot="avatar"]')).not.toBeNull();
  });

  it('renders the online indicator on a DM header avatar', () => {
    render(<Header title="Alice" showAvatar avatarOnline />);

    expect(screen.getByLabelText('Online')).toBeInTheDocument();
  });

  it('opens the user hover card from a DM header title', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/users/u-alice') {
        return Promise.resolve({
          id: 'u-alice',
          displayName: 'Alice',
          email: 'alice@example.com',
          status: 'active',
          systemRole: 'member',
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderHeaderWithProviders(<Header title="Alice" showAvatar userId="u-alice" currentUserId="u-me" />);

    await user.click(screen.getByText('Alice'));
    expect(await screen.findByRole('link', { name: 'alice@example.com' })).toHaveAttribute('href', 'mailto:alice@example.com');
  });

  it('opens the user hover card from a DM header avatar', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/users/u-alice') {
        return Promise.resolve({
          id: 'u-alice',
          displayName: 'Alice',
          email: 'alice@example.com',
          status: 'active',
          systemRole: 'member',
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const { container } = renderHeaderWithProviders(
      <Header title="Alice" showAvatar userId="u-alice" currentUserId="u-me" />,
    );

    await user.click(container.querySelector('[data-slot="avatar"]') as HTMLElement);

    expect(await screen.findByRole('link', { name: 'alice@example.com' })).toHaveAttribute('href', 'mailto:alice@example.com');
  });

  it('renders one status indicator in a DM header', () => {
    renderHeaderWithProviders(
      <Header
        title="Alice"
        showAvatar
        userId="u-alice"
        currentUserId="u-me"
        userStatus={{ emoji: ':house:', text: 'Working from home' }}
      />,
    );

    expect(screen.getAllByLabelText(/Working from home/)).toHaveLength(1);
  });
});
