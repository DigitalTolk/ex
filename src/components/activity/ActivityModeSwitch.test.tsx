import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityModeSwitch } from './ActivityModeSwitch';
import { apiFetch } from '@/lib/api';
import { resetSidebarModeForTests, setSidebarMode, useSidebarModeStore } from '@/stores/sidebar-mode';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderAt(path: string, unread: number) {
  vi.mocked(apiFetch).mockResolvedValue({ items: [], unread, unreadByType: {} });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <ActivityModeSwitch />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ActivityModeSwitch', () => {
  beforeEach(() => {
    resetSidebarModeForTests();
    vi.mocked(apiFetch).mockReset();
  });

  it('starts on Home and shows the unread count on Activity', async () => {
    renderAt('/channel/general', 4);
    expect(screen.getByTestId('sidebar-mode-home')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('activity-unread-badge')).toHaveTextContent('4');
  });

  it('caps the count at 99+ and hides it when nothing is unread', async () => {
    const { unmount } = renderAt('/', 150);
    expect(await screen.findByTestId('activity-unread-badge')).toHaveTextContent('99+');
    unmount();
    renderAt('/', 0);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('activity-unread-badge')).toBeNull();
  });

  it('puts the count beside the label when Activity is selected, and none at zero', async () => {
    setSidebarMode('activity');
    const { unmount } = renderAt('/channel/general', 3);
    const badge = await screen.findByTestId('activity-unread-badge');
    expect(badge).toHaveTextContent('3');
    expect(badge).toHaveClass('ml-2');
    unmount();
    renderAt('/channel/general', 0);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('activity-unread-badge')).toBeNull();
  });

  it('switches the sidebar without leaving the page', () => {
    renderAt('/channel/general', 0);
    fireEvent.click(screen.getByTestId('sidebar-mode-activity'));
    expect(useSidebarModeStore.getState().mode).toBe('activity');
    expect(screen.getByTestId('sidebar-mode-activity')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByTestId('sidebar-mode-home'));
    expect(useSidebarModeStore.getState().mode).toBe('home');
    expect(screen.getByTestId('where')).toHaveTextContent('/channel/general');
  });

  it('goes home when leaving Activity from the Activity page', () => {
    setSidebarMode('activity');
    renderAt('/activity', 0);
    fireEvent.click(screen.getByTestId('sidebar-mode-home'));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
  });
});
