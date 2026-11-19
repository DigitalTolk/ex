import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from './AppLayout';

vi.mock('./Sidebar', () => ({
  Sidebar: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="sidebar">
      <button onClick={onClose}>Close sidebar</button>
    </div>
  ),
}));

vi.mock('@/components/UpdateBanner', () => ({
  UpdateBanner: () => null,
}));

vi.mock('@/components/NotificationPermissionBanner', () => ({
  NotificationPermissionBanner: () => null,
}));

// The phone tab bar still draws the account menu.
vi.mock('./AccountMenu', () => ({ AccountMenu: () => <div data-testid="sidebar-account" /> }));
// The icon rail and the column header have their own tests; here they are
// markers, so the layout's structure can be read without their providers.
vi.mock('./SidebarRail', () => ({
  SidebarRail: ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav data-testid="sidebar-rail">
      <button type="button" onClick={onNavigate}>Rail link</button>
    </nav>
  ),
}));
vi.mock('./SidebarColumnHeader', () => ({
  SidebarColumnHeader: ({ children }: { children?: ReactNode }) => <div data-testid="sidebar-column-header">{children}</div>,
}));
vi.mock('./AppTopBar', () => ({
  AppTopBar: () => (
    <header data-testid="app-shell-header" data-app-chrome="true">
      <button aria-label="Open channels">menu</button>
    </header>
  ),
}));

function renderLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AppLayout>
          <div>main</div>
        </AppLayout>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('AppLayout - mobile navigation', () => {
  it('does not use a temporary sidebar overlay on mobile', () => {
    const { container } = renderLayout();

    expect(screen.getByTestId('app-sidebar')).toContainElement(screen.getByTestId('sidebar'));
    expect(container.querySelector('.bg-black\\/50')).toBeNull();
  });
});
