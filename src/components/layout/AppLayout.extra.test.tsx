import { describe, it, expect, vi } from 'vitest';
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

    const aside = screen.getByTestId('sidebar').closest('aside')!;
    expect(aside.className).toContain('lg:block');
    expect(container.querySelector('.bg-black\\/50')).toBeNull();
  });
});
