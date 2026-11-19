import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarRail } from './SidebarRail';
import { apiFetch } from '@/lib/api';
import { flashReaction, REACTION_FLASH_MS } from '@/stores/reaction-flash';
import { setSidebarMode, useSidebarModeStore } from '@/stores/sidebar-mode';
import { setSidebarTheme } from '@/stores/sidebar-theme';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

// The account menu at the rail's foot has its own tests; its dialogs stay
// out of this one.
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'alice@example.com', displayName: 'Alice Wonder', avatarURL: '', systemRole: 'member', notificationSettings: {} },
    logout: vi.fn(),
    setAuth: vi.fn(),
  }),
}));
vi.mock('@/components/settings/SettingsDialog', () => ({ SettingsDialog: () => null }));
vi.mock('@/components/emoji/CustomEmojiDialog', () => ({ CustomEmojiDialog: () => null }));
vi.mock('@/components/UserStatusDialog', () => ({ UserStatusDialog: () => null }));
vi.mock('@/components/AboutDialog', () => ({ AboutDialog: () => null }));
vi.mock('@/components/InviteDialog', () => ({ InviteDialog: () => null }));
vi.mock('@/components/RunnersDialog', () => ({ RunnersDialog: () => null }));
vi.mock('@/lib/capacitor', () => ({ getCapacitorPlugin: () => null, isNativePlatform: () => false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useEmoji', () => ({ useEmojiMap: () => ({ data: {} }) }));

// What the server holds for alice; each test sets what it relies on.
interface ServerState {
  activityUnread: number;
  reactionUnread: number;
  unreadThreads: string[];
  drafts: number;
  userStateFails: boolean;
}
let server: ServerState;

function mockApi() {
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/activity')) {
      return { items: [], unread: server.activityUnread, unreadByType: { reaction: server.reactionUnread } } as never;
    }
    if (url === '/api/v1/user-state') {
      if (server.userStateFails) throw new Error('user state unavailable');
      return { threadNotifications: server.unreadThreads, hiddenConversations: [], hiddenSkills: [] } as never;
    }
    if (url === '/api/v1/drafts') {
      return Array.from({ length: server.drafts }, (_, i) => ({ id: `d-${i}`, gen: `g-${i}`, parentID: `ch-${i}`, body: 'hello' })) as never;
    }
    return [] as never;
  });
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderRail(path = '/channel/general', onNavigate?: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <SidebarRail onNavigate={onNavigate} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // The counts have arrived (or failed) once nothing is being fetched.
  const settled = () => waitFor(() => expect(qc.isFetching()).toBe(0));
  return { settled };
}

const rail = () => screen.getByTestId('sidebar-rail');
const stop = (name: 'threads' | 'drafts' | 'directory' | 'agents') => screen.getByTestId(`sidebar-rail-${name}`);
const bell = () => screen.getByTestId('sidebar-mode-activity');

describe('SidebarRail', () => {
  beforeEach(() => {
    server = { activityUnread: 0, reactionUnread: 0, unreadThreads: [], drafts: 0, userStateFails: false };
    vi.mocked(apiFetch).mockReset();
    mockApi();
  });

  it('lists the places every screen can reach, then Do Not Disturb and the account at its foot', async () => {
    const { settled } = renderRail();
    await settled();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav).toBe(rail());

    const order = [
      'sidebar-rail-logo',
      'sidebar-rail-threads',
      'sidebar-mode-activity',
      'sidebar-rail-drafts',
      'sidebar-rail-directory',
      'sidebar-rail-agents',
      'dnd-trigger',
      'account-menu-trigger',
    ];
    const found = Array.from(nav.querySelectorAll<HTMLElement>('[data-testid]'))
      .map((el) => el.dataset.testid!)
      .filter((id) => order.includes(id));
    expect(found).toEqual(order);

    expect(within(nav).getByRole('link', { name: 'Threads' })).toHaveAttribute('href', '/threads');
    expect(within(nav).getByRole('link', { name: 'Drafts' })).toHaveAttribute('href', '/drafts');
    expect(within(nav).getByRole('link', { name: 'Directory' })).toHaveAttribute('href', '/directory/channels');
    expect(within(nav).getByRole('link', { name: 'Agents and tools' })).toHaveAttribute('href', '/agents');
    // Each stop wears its own icon; Agents & tools is the workflow mark.
    const icon = (testID: string) => within(nav).getByTestId(testID).querySelector('svg')!.getAttribute('class');
    expect(icon('sidebar-rail-agents')).toContain('lucide-workflow');
    expect(icon('sidebar-rail-threads')).toContain('lucide-messages-square');
    expect(icon('sidebar-rail-directory')).toContain('lucide-book-user');
    expect(within(nav).getByRole('button', { name: 'Activity' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(nav).getByRole('button', { name: 'Pause notifications' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it("wears the server's own mark and writes each stop's name under its icon", async () => {
    const { settled } = renderRail();
    await settled();
    const logo = screen.getByTestId('sidebar-rail-logo') as HTMLImageElement;
    // No favicon declared in the test page: the bundled one.
    expect(logo.getAttribute('src')).toBe('/favicon.svg');
    expect(logo).toHaveAttribute('width', '32');
    expect(logo).toHaveAttribute('height', '32');

    expect(screen.getByTestId('threads-nav-label')).toHaveTextContent('Threads');
    expect(within(stop('drafts')).getByText('Drafts')).toBeInTheDocument();
    expect(within(stop('directory')).getByText('Directory')).toBeInTheDocument();
    expect(within(bell()).getByText('Activity')).toBeInTheDocument();
    // "Agents & tools" breaks over two lines; its link keeps one plain name.
    const agentsLabel = stop('agents').querySelector('span[aria-hidden="true"]')!;
    expect(agentsLabel.querySelector('br')).not.toBeNull();
    expect(agentsLabel.textContent).toBe('Agents& tools');
  });

  it.each([
    { path: '/threads', lit: 'threads' },
    { path: '/drafts', lit: 'drafts' },
    { path: '/directory', lit: 'directory' },
    { path: '/directory/people', lit: 'directory' },
    { path: '/agents', lit: 'agents' },
    { path: '/skills/sk-1', lit: 'agents' },
    { path: '/channel/general', lit: null },
    { path: '/conversation/cv-1', lit: null },
    // A page that only starts like one of the rail's.
    { path: '/directoryish', lit: null },
  ] as const)('on $path lights $lit', async ({ path, lit }) => {
    const { settled } = renderRail(path);
    await settled();
    for (const name of ['threads', 'drafts', 'directory', 'agents'] as const) {
      if (name === lit) expect(stop(name)).toHaveAttribute('aria-current', 'page');
      else expect(stop(name)).not.toHaveAttribute('aria-current');
    }
    // Activity is lit by the sidebar's mode, never by the page.
    expect(bell()).toHaveAttribute('aria-pressed', 'false');
  });

  it('counts unread threads, unread activity and drafts on their stops, and says so in their names', async () => {
    server = { ...server, activityUnread: 4, unreadThreads: ['t-1', 't-2'], drafts: 3 };
    const { settled } = renderRail();

    expect(await screen.findByTestId('threads-unread-badge')).toHaveTextContent('2');
    expect(await screen.findByTestId('activity-unread-badge')).toHaveTextContent('4');
    expect(await within(stop('drafts')).findByText('3')).toBeInTheDocument();
    await settled();

    expect(stop('threads')).toHaveAccessibleName('Threads, 2 unread');
    expect(bell()).toHaveAccessibleName('Activity, 4 unread');
    expect(stop('drafts')).toHaveAccessibleName('Drafts, 3 unread');
    // The stops that count nothing never grow a badge.
    expect(stop('directory').querySelector('[data-slot="badge"]')).toBeNull();
    expect(stop('agents').querySelector('[data-slot="badge"]')).toBeNull();
  });

  it('caps a count at 99+ and leaves reactions out of the Activity number', async () => {
    server = {
      ...server,
      activityUnread: 150,
      reactionUnread: 10,
      unreadThreads: Array.from({ length: 100 }, (_, i) => `t-${i}`),
      drafts: 99,
    };
    const { settled } = renderRail();

    expect(await screen.findByTestId('threads-unread-badge')).toHaveTextContent('99+');
    expect(await screen.findByTestId('activity-unread-badge')).toHaveTextContent('99+');
    // 99 is still written out.
    expect(await within(stop('drafts')).findByText('99')).toBeInTheDocument();
    await settled();
    // The name carries the real number.
    expect(bell()).toHaveAccessibleName('Activity, 140 unread');
    expect(stop('threads')).toHaveAccessibleName('Threads, 100 unread');
  });

  it('shows no badge when nothing is unread', async () => {
    const { settled } = renderRail();
    await settled();
    expect(screen.queryByTestId('threads-unread-badge')).toBeNull();
    expect(screen.queryByTestId('activity-unread-badge')).toBeNull();
    expect(rail().querySelector('[data-slot="badge"]')).toBeNull();
    expect(stop('threads')).toHaveAccessibleName('Threads');
    expect(stop('drafts')).toHaveAccessibleName('Drafts');
    expect(bell()).toHaveAccessibleName('Activity');
  });

  it('keeps the Threads stop plain when its count cannot be loaded', async () => {
    server = { ...server, userStateFails: true, drafts: 1 };
    const { settled } = renderRail();
    expect(await within(stop('drafts')).findByText('1')).toBeInTheDocument();
    await settled();
    expect(screen.queryByTestId('threads-unread-badge')).toBeNull();
    expect(stop('threads')).toHaveAccessibleName('Threads');
  });

  it('Activity swaps the sidebar list and back, without leaving the page', async () => {
    const { settled } = renderRail('/channel/general');
    await settled();

    fireEvent.click(bell());
    expect(useSidebarModeStore.getState().mode).toBe('activity');
    expect(bell()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('where')).toHaveTextContent('/channel/general');

    fireEvent.click(bell());
    expect(useSidebarModeStore.getState().mode).toBe('home');
    expect(bell()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('where')).toHaveTextContent('/channel/general');
  });

  it('lights Activity and the page together while the sidebar lists Activity on a rail page', async () => {
    act(() => setSidebarMode('activity'));
    const { settled } = renderRail('/drafts');
    await settled();
    expect(bell()).toHaveAttribute('aria-pressed', 'true');
    expect(stop('drafts')).toHaveAttribute('aria-current', 'page');
  });

  it('going to a page leaves Activity, opens the page and tells the layout', async () => {
    const onNavigate = vi.fn();
    const { settled } = renderRail('/channel/general', onNavigate);
    await settled();
    fireEvent.click(bell());
    expect(useSidebarModeStore.getState().mode).toBe('activity');

    fireEvent.click(stop('threads'));
    expect(screen.getByTestId('where')).toHaveTextContent('/threads');
    expect(stop('threads')).toHaveAttribute('aria-current', 'page');
    expect(useSidebarModeStore.getState().mode).toBe('home');
    expect(bell()).toHaveAttribute('aria-pressed', 'false');
    expect(onNavigate).toHaveBeenCalledTimes(1);

    fireEvent.click(stop('agents'));
    expect(screen.getByTestId('where')).toHaveTextContent('/agents');
    expect(stop('agents')).toHaveAttribute('aria-current', 'page');
    expect(stop('threads')).not.toHaveAttribute('aria-current');
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it('opens its pages just the same with no layout listening', async () => {
    const { settled } = renderRail('/channel/general');
    await settled();
    fireEvent.click(stop('directory'));
    expect(screen.getByTestId('where')).toHaveTextContent('/directory/channels');
    expect(stop('directory')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(stop('drafts'));
    expect(screen.getByTestId('where')).toHaveTextContent('/drafts');
  });

  it('previews the latest activity while the mouse rests on the bell, and closes it when the mouse leaves', async () => {
    const { settled } = renderRail();
    await settled();
    expect(screen.queryByTestId('activity-preview')).toBeNull();

    fireEvent.pointerEnter(bell(), { pointerType: 'mouse' });
    const card = await screen.findByTestId('activity-preview');
    expect(await within(card).findByTestId('activity-preview-empty')).toHaveTextContent('No activity yet');
    // A look only: the sidebar keeps its list.
    expect(useSidebarModeStore.getState().mode).toBe('home');

    fireEvent.pointerLeave(bell());
    await waitFor(() => expect(screen.queryByTestId('activity-preview')).toBeNull());
    expect(useSidebarModeStore.getState().mode).toBe('home');
  });

  it('clicking the bell closes the preview and lists Activity in the sidebar', async () => {
    const { settled } = renderRail();
    await settled();
    fireEvent.pointerEnter(bell(), { pointerType: 'mouse' });
    const card = await screen.findByTestId('activity-preview');
    await within(card).findByTestId('activity-preview-empty');

    fireEvent.click(bell());
    await waitFor(() => expect(screen.queryByTestId('activity-preview')).toBeNull());
    expect(useSidebarModeStore.getState().mode).toBe('activity');
    expect(bell()).toHaveAttribute('aria-pressed', 'true');
  });

  it('flashes a reaction in place of the bell, then brings the bell back', () => {
    vi.useFakeTimers();
    try {
      renderRail();
      expect(screen.queryByTestId('activity-reaction-flash')).toBeNull();
      expect(bell().querySelector('svg')).not.toBeNull();

      act(() => flashReaction(':tada:'));
      expect(within(bell()).getByTestId('activity-reaction-flash')).toHaveAttribute('aria-label', 'Reaction :tada:');
      expect(bell().querySelector('svg.lucide-bell')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(REACTION_FLASH_MS);
      });
      expect(screen.queryByTestId('activity-reaction-flash')).toBeNull();
      expect(bell().querySelector('svg.lucide-bell')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays dark by default, and follows the app theme, with a line to the list, once set to light', async () => {
    const { settled } = renderRail();
    await settled();
    expect(rail()).toHaveClass('dark');
    expect(rail()).not.toHaveClass('border-r');

    act(() => setSidebarTheme('light'));
    expect(rail()).not.toHaveClass('dark');
    expect(rail()).toHaveClass('border-r', 'border-sidebar-border');

    act(() => setSidebarTheme('dark'));
    expect(rail()).toHaveClass('dark');
    expect(rail()).not.toHaveClass('border-r');
  });
});
