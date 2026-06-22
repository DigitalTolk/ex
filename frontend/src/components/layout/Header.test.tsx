import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

describe('Header', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({});
    setMobileMatch(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders channel name', () => {
    render(<Header channel={makeChannel({ name: 'general' })} />);

    expect(screen.getByText('general')).toBeInTheDocument();
  });

  it('keeps right-side actions visible when the channel name is long', () => {
    render(
      <Header
        channel={makeChannel({ name: 'a-very-long-channel-name-that-still-needs-actions-visible' })}
        onFilesClick={vi.fn()}
        onPinnedClick={vi.fn()}
        memberCount={12}
      />,
    );

    expect(screen.getByRole('heading', { name: /a-very-long-channel-name/ })).toHaveClass('min-w-0', 'truncate');
    expect(screen.getByLabelText('View shared files')).toBeInTheDocument();
    expect(screen.getByTestId('files-toggle').parentElement).toHaveClass('shrink-0');
  });

  it('publishes the measured channel header bottom for mobile right panels', () => {
    const { container, unmount } = render(<Header channel={makeChannel({ name: 'general' })} />);
    const shell = container.firstElementChild as HTMLElement;
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({
      bottom: 123.4,
      height: 60,
      left: 0,
      right: 390,
      top: 63,
      width: 390,
      x: 0,
      y: 63,
      toJSON: () => ({}),
    } as DOMRect);

    act(() => window.dispatchEvent(new Event('resize')));

    expect(document.documentElement.style.getPropertyValue('--mobile-right-panel-top')).toBe('123.4px');
    unmount();
    expect(document.documentElement.style.getPropertyValue('--mobile-right-panel-top')).toBe('');
  });

  it('publishes mobile right-panel top relative to the transformed app main container', () => {
    const { container, unmount } = render(
      <main data-app-main="true">
        <Header channel={makeChannel({ name: 'general' })} />
      </main>,
    );
    const main = container.querySelector('[data-app-main="true"]') as HTMLElement;
    const shell = container.querySelector('[data-testid="channel-header-shell"]') as HTMLElement;
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 600,
      left: 0,
      right: 390,
      top: 105,
      width: 390,
      x: 0,
      y: 105,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({
      bottom: 223,
      height: 118,
      left: 0,
      right: 390,
      top: 105,
      width: 390,
      x: 0,
      y: 105,
      toJSON: () => ({}),
    } as DOMRect);

    act(() => window.dispatchEvent(new Event('resize')));

    expect(document.documentElement.style.getPropertyValue('--mobile-right-panel-top')).toBe('118px');
    unmount();
    expect(document.documentElement.style.getPropertyValue('--mobile-right-panel-top')).toBe('');
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

  it('opens the inline description editor when an editor clicks the desktop description', () => {
    render(
      <Header
        channel={makeChannel({ description: 'General discussion' })}
        canEdit
        onDescriptionSave={vi.fn()}
      />,
    );
    // canEdit renders the description as a button; clicking it swaps in the
    // inline textarea editor seeded with the current description.
    fireEvent.click(screen.getByRole('button', { name: 'General discussion' }));
    const editor = screen.getByPlaceholderText('Add a description...') as HTMLTextAreaElement;
    expect(editor).toBeInTheDocument();
    expect(editor.value).toBe('General discussion');
  });

  it('renders the subtitle inside the hover-card DM header', () => {
    renderHeaderWithProviders(
      <Header
        title="Alice"
        subtitle="Active now"
        showAvatar
        userId="u-alice"
        currentUserId="u-me"
      />,
    );
    expect(screen.getByText('Active now')).toBeInTheDocument();
  });

  it('cancels the mobile description editor when the dialog is dismissed', async () => {
    setMobileMatch(true);
    const user = userEvent.setup();
    renderHeaderWithProviders(
      <Header channel={makeChannel()} canEdit onDescriptionSave={vi.fn()} />,
    );
    await user.click(screen.getByText('general').closest('button')!);
    const menu = within(document.getElementById('mobile-channel-menu')!);
    await user.click(menu.getByText('Edit description'));
    const dialog = await screen.findByTestId('mobile-description-editor');
    // Dismissing the dialog via its Close button routes through
    // onOpenChange(false) → cancelDescriptionEdit, closing the editor.
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByTestId('mobile-description-editor')).not.toBeInTheDocument(),
    );
  });

  it('fires onNotificationPrefsClick from the channel menu', async () => {
    setMobileMatch(true);
    const user = userEvent.setup();
    const onNotificationPrefsClick = vi.fn();
    renderHeaderWithProviders(
      <Header channel={makeChannel()} onNotificationPrefsClick={onNotificationPrefsClick} />,
    );
    await user.click(screen.getByText('general').closest('button')!);
    const menu = within(document.getElementById('mobile-channel-menu')!);
    await user.click(menu.getByText('Notification preferences'));
    expect(onNotificationPrefsClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the desktop channel description in the title row', () => {
    render(
      <Header
        channel={makeChannel({ description: 'General discussion' })}
        memberCount={4}
        onFilesClick={vi.fn()}
      />,
    );

    const description = screen.getByText('General discussion');
    expect(screen.getByTestId('channel-title-stack')).toContainElement(description);
    expect(screen.getByTestId('channel-title-stack')).toHaveClass('items-center', 'gap-2');
    expect(description).toHaveClass('text-left', 'truncate');
    expect(description).not.toHaveClass('ml-auto', 'text-right', 'mt-0.5');
  });

  it('does not render the channel description on mobile so short names keep the header width', () => {
    setMobileMatch(true);
    render(
      <Header
        channel={makeChannel({ name: 'general', description: 'General discussion' })}
        memberCount={4}
        onFilesClick={vi.fn()}
      />,
    );

    const title = screen.getByRole('heading', { name: 'general' });
    expect(title).toHaveClass('truncate');
    expect(screen.getByTestId('channel-title-stack')).toHaveClass('flex-1', 'min-w-0');
    expect(screen.queryByText('General discussion')).not.toBeInTheDocument();
  });

  it('keeps the channel dropdown trigger as a desktop dropdown without mobile menu state', () => {
    setMobileMatch(false);
    render(<Header channel={makeChannel()} canEdit />);

    const trigger = screen.getByText('general').closest('button');
    expect(trigger).not.toHaveAttribute('aria-controls', 'mobile-channel-menu');
    expect(trigger).not.toHaveAttribute('aria-expanded');
    expect(screen.queryByTestId('mobile-channel-menu')).not.toBeInTheDocument();
  });

  it('uses the inline channel menu only on mobile', async () => {
    setMobileMatch(true);
    const user = userEvent.setup();
    render(<Header channel={makeChannel()} canEdit />);

    await user.click(screen.getByText('general').closest('button')!);

    expect(screen.getByTestId('mobile-channel-menu')).toHaveClass('md:hidden');
    expect(screen.getByText('general').closest('button')).toHaveAttribute('aria-controls', 'mobile-channel-menu');
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

  it('files toggle fires onFilesClick and reflects filesActive via aria-pressed', async () => {
    const onFiles = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderHeaderWithProviders(
      <Header channel={makeChannel()} onFilesClick={onFiles} filesActive={false} />,
    );
    const btn = screen.getByTestId('files-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    await user.click(btn);
    expect(onFiles).toHaveBeenCalledTimes(1);
    rerender(<Header channel={makeChannel()} onFilesClick={onFiles} filesActive />);
    expect(screen.getByTestId('files-toggle').getAttribute('aria-pressed')).toBe('true');
  });

  it('pinned toggle fires onPinnedClick and reflects pinnedActive via aria-pressed', async () => {
    const onPinned = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderHeaderWithProviders(
      <Header channel={makeChannel()} onPinnedClick={onPinned} pinnedActive={false} />,
    );
    const btn = screen.getByRole('button', { name: /pinned/i });
    await user.click(btn);
    expect(onPinned).toHaveBeenCalledTimes(1);
    rerender(<Header channel={makeChannel()} onPinnedClick={onPinned} pinnedActive />);
    const next = screen.getByRole('button', { name: /pinned/i });
    expect(next.getAttribute('aria-pressed')).toBe('true');
  });

  it('omits files toggle when onFilesClick is undefined', () => {
    renderHeaderWithProviders(<Header channel={makeChannel()} />);
    expect(screen.queryByTestId('files-toggle')).toBeNull();
  });

  it('omits pinned toggle when onPinnedClick is undefined', () => {
    renderHeaderWithProviders(<Header channel={makeChannel()} />);
    expect(screen.queryByRole('button', { name: /pinned/i })).toBeNull();
  });

  it('exposes a dropdown trigger that combines the channel icon, title, and chevron', () => {
    renderHeaderWithProviders(<Header channel={makeChannel({ name: 'engineering' })} />);
    const trigger = screen.getByText('engineering').closest('button');
    expect(trigger).toBeTruthy();
    // Same trigger carries the channel icon and the chevron-down marker.
    expect(trigger?.querySelector('svg.lucide-chevron-down')).toBeTruthy();
  });

  it('reports the channel description in the inline edit affordance when canEdit is true', () => {
    renderHeaderWithProviders(
      <Header
        channel={makeChannel({ description: 'Engineering team chat' })}
        canEdit
        onDescriptionSave={vi.fn()}
      />,
    );
    expect(screen.getByText('Engineering team chat')).toBeTruthy();
  });

  it('renders an empty title when neither channel nor title is provided', () => {
    const { container } = renderHeaderWithProviders(<Header />);
    const heading = container.querySelector('h1');
    expect(heading?.textContent).toBe('');
  });

  it('exposes edit/mute/leave/archive actions in the desktop channel dropdown', async () => {
    const user = userEvent.setup();
    const onToggleMute = vi.fn();
    renderHeaderWithProviders(
      <Header
        channel={makeChannel()}
        canEdit
        canLeave
        canArchive
        muted={false}
        onToggleMute={onToggleMute}
        onDescriptionSave={vi.fn()}
        onLeave={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    await user.click(screen.getByText('general').closest('button')!);
    expect(await screen.findByText('Edit description')).toBeTruthy();
    expect(screen.getByText('Leave channel')).toBeTruthy();
    expect(screen.getByText('Archive channel')).toBeTruthy();

    await user.click(screen.getByRole('menuitem', { name: 'Mute channel' }));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it('labels the mute action as Unmute when the channel is already muted', async () => {
    const user = userEvent.setup();
    renderHeaderWithProviders(
      <Header channel={makeChannel()} muted onToggleMute={vi.fn()} />,
    );
    await user.click(screen.getByText('general').closest('button')!);
    expect(await screen.findByRole('menuitem', { name: 'Unmute channel' })).toBeTruthy();
  });

  it('degrades gracefully when ResizeObserver and MutationObserver are unavailable', () => {
    const origRO = window.ResizeObserver;
    const origMO = window.MutationObserver;
    // @ts-expect-error — simulate an environment without the observers.
    delete window.ResizeObserver;
    // @ts-expect-error — simulate an environment without the observers.
    delete window.MutationObserver;
    try {
      const { unmount } = render(<Header channel={makeChannel({ name: 'general' })} />);
      // The resize listener still drives the CSS variable without observers.
      act(() => window.dispatchEvent(new Event('resize')));
      expect(() => unmount()).not.toThrow();
    } finally {
      window.ResizeObserver = origRO;
      window.MutationObserver = origMO;
    }
  });

  it('toggles the inline mobile channel menu open and closed on the trigger', async () => {
    setMobileMatch(true);
    const user = userEvent.setup();
    renderHeaderWithProviders(<Header channel={makeChannel()} canEdit onDescriptionSave={vi.fn()} />);
    const trigger = screen.getByText('general').closest('button')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('exposes the full action set in the inline mobile channel menu', async () => {
    setMobileMatch(true);
    const user = userEvent.setup();
    const onArchive = vi.fn();
    renderHeaderWithProviders(
      <Header
        channel={makeChannel()}
        canEdit
        canLeave
        canArchive
        muted
        onToggleMute={vi.fn()}
        onDescriptionSave={vi.fn()}
        onLeave={vi.fn()}
        onArchive={onArchive}
      />,
    );
    await user.click(screen.getByText('general').closest('button')!);
    // Scope to the inline mobile menu (the desktop dropdown also renders
    // these labels but is CSS-hidden via max-md:hidden).
    const menu = within(document.getElementById('mobile-channel-menu')!);
    expect(menu.getByText('Edit description')).toBeTruthy();
    // muted → 'Unmute channel' label in the mobile menu.
    expect(menu.getByLabelText('Unmute channel')).toBeTruthy();
    expect(menu.getByText('Leave channel')).toBeTruthy();
    await user.click(menu.getByText('Archive channel'));
    // Archive opens a confirmation dialog rather than calling onArchive directly.
    expect(await screen.findByText('Archive channel?')).toBeInTheDocument();
  });

  it('renders a DM header with avatar, status indicator, and subtitle', () => {
    renderHeaderWithProviders(
      <Header
        title="Alice"
        showAvatar
        avatarURL="https://x/a.png"
        userStatus={{ emoji: ':wave:', text: 'Hi' }}
        subtitle="Active now"
        avatarOnline
      />,
    );
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Active now')).toBeInTheDocument();
  });

  it('falls back to "?" avatar initials in the hover-card DM header when the title is empty', () => {
    // userId + currentUserId routes through the UserHoverCard branch; an empty
    // title hits the `displayTitle || "??"` fallback and the absent subtitle
    // exercises the falsy `subtitle &&` branch.
    renderHeaderWithProviders(
      <Header showAvatar userId="u-alice" currentUserId="u-me" />,
    );
    expect(screen.getByText('?')).toBeInTheDocument();
    expect(screen.queryByText('Active now')).not.toBeInTheDocument();
  });

  it('falls back to "?" avatar initials in the plain DM header when the title is empty', () => {
    // No userId/currentUserId → the non-hover-card branch; empty title hits its
    // own `displayTitle || "??"` fallback and there is no subtitle paragraph.
    render(<Header showAvatar />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('labels the mobile menu mute action as Mute when the channel is not muted', async () => {
    setMobileMatch(true);
    const user = userEvent.setup();
    renderHeaderWithProviders(
      <Header channel={makeChannel()} muted={false} onToggleMute={vi.fn()} />,
    );
    await user.click(screen.getByText('general').closest('button')!);
    const menu = within(document.getElementById('mobile-channel-menu')!);
    // not muted → 'Mute channel' label in the mobile menu.
    expect(menu.getByLabelText('Mute channel')).toBeTruthy();
  });
});
