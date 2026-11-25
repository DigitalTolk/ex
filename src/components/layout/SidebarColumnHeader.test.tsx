import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarColumnHeader } from './SidebarColumnHeader';
import { apiFetch } from '@/lib/api';
import { useAddCategoryRequest } from '@/stores/sidebar-add-category';
import { setSidebarMode, useSidebarModeStore } from '@/stores/sidebar-mode';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

let mockUser: { id: string; displayName: string; systemRole: 'admin' | 'member' | 'guest' } | null;
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderHeader(onNavigate?: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/channel/general']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <SidebarColumnHeader onNavigate={onNavigate}>
                  <span data-testid="server-name">chat.example.com</span>
                </SidebarColumnHeader>
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Opens the "+" menu and returns its popup.
async function openMenu() {
  fireEvent.click(screen.getByTestId('sidebar-create-menu'));
  return screen.findByRole('menu');
}

async function choose(testID: string) {
  const menu = await openMenu();
  fireEvent.click(within(menu).getByTestId(testID));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
}

describe('SidebarColumnHeader', () => {
  beforeEach(() => {
    mockUser = { id: 'u-1', displayName: 'Alice', systemRole: 'member' };
    vi.mocked(apiFetch).mockReset();
  });

  it('shows what the list offers on the left and the "+" beside it', () => {
    renderHeader();
    const header = screen.getByTestId('sidebar-column-header');
    expect(within(header).getByTestId('server-name')).toHaveTextContent('chat.example.com');
    const plus = within(header).getByRole('button', { name: 'Create new' });
    expect(plus).toHaveAttribute('title', 'Create new');
    // Closed until asked for.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByText('Create a channel')).toBeNull();
  });

  it('lists what can be started: a channel, a message, a category, and the way to browse', async () => {
    renderHeader();
    const menu = await openMenu();
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'New channel',
      'New message',
      'New category',
      'Browse channels',
    ]);
    // Browsing is set apart from the three that create something.
    const separator = within(menu).getByRole('separator');
    const browse = within(menu).getByTestId('sidebar-browse-channels');
    expect(separator.compareDocumentPosition(browse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      within(menu).getByTestId('sidebar-create-category').compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('"New channel" opens the dialog, creates the channel and goes to it', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/v1/channels' && options?.method === 'POST') {
        return { id: 'ch-9', name: 'launch-plans', slug: 'launch-plans', type: 'public' } as never;
      }
      return { available: true } as never;
    });
    const onNavigate = vi.fn();
    renderHeader(onNavigate);

    await choose('sidebar-menu-new-channel');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Create a channel')).toBeInTheDocument();
    // Still on the page it was opened from.
    expect(screen.getByTestId('where')).toHaveTextContent('/channel/general');

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'launch-plans' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Channel' }));

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/channel/launch-plans'));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'launch-plans', type: 'public' }),
    });
    await waitFor(() => expect(screen.queryByText('Create a channel')).toBeNull());
  });

  it('closes the channel dialog on Cancel and creates nothing', async () => {
    renderHeader();
    await choose('sidebar-menu-new-channel');
    const dialog = await screen.findByRole('dialog');

    // The desktop footer's Cancel (the phone's sits in the dialog's top bar).
    fireEvent.click(within(dialog).getByText('Cancel'));

    await waitFor(() => expect(screen.queryByText('Create a channel')).toBeNull());
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent('/channel/general');
  });

  it('"New message" goes to the new-conversation page and tells the layout', async () => {
    const onNavigate = vi.fn();
    renderHeader(onNavigate);
    await choose('sidebar-menu-new-message');
    expect(screen.getByTestId('where')).toHaveTextContent('/conversations/new');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('"Browse channels" goes to the channel directory and tells the layout', async () => {
    const onNavigate = vi.fn();
    renderHeader(onNavigate);
    await choose('sidebar-browse-channels');
    expect(screen.getByTestId('where')).toHaveTextContent('/directory/channels');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('navigates just the same with no layout listening', async () => {
    renderHeader();
    await choose('sidebar-menu-new-message');
    expect(screen.getByTestId('where')).toHaveTextContent('/conversations/new');
  });

  it('"New category" brings the channel list back and asks it for its new-category field, each time', async () => {
    const onNavigate = vi.fn();
    renderHeader(onNavigate);
    act(() => setSidebarMode('activity'));

    await choose('sidebar-create-category');
    // The field lives in the channel list, so Activity gives way to it.
    expect(useSidebarModeStore.getState().mode).toBe('home');
    expect(useAddCategoryRequest.getState().asked).toBe(1);

    await choose('sidebar-create-category');
    expect(useAddCategoryRequest.getState().asked).toBe(2);
    // It changes no page.
    expect(screen.getByTestId('where')).toHaveTextContent('/channel/general');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('offers a guest everything but a new channel', async () => {
    mockUser = { id: 'u-2', displayName: 'Gus', systemRole: 'guest' };
    renderHeader();
    const menu = await openMenu();
    expect(within(menu).queryByTestId('sidebar-menu-new-channel')).toBeNull();
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'New message',
      'New category',
      'Browse channels',
    ]);
  });

  it('renders before the user is known', async () => {
    mockUser = null;
    renderHeader();
    const menu = await openMenu();
    expect(within(menu).getByTestId('sidebar-menu-new-message')).toBeInTheDocument();
  });
});
