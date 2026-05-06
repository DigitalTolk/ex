import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from './AppLayout';

// Mock the Sidebar to avoid pulling in all its dependencies
vi.mock('./Sidebar', () => ({
  Sidebar: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="sidebar">
      <button onClick={onClose}>Close sidebar</button>
    </div>
  ),
}));

function renderLayout(children: React.ReactNode = <div>Main content</div>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AppLayout>{children}</AppLayout>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('AppLayout', () => {
  beforeEach(() => {
    delete window.Capacitor;
  });

  it('renders sidebar', () => {
    renderLayout();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('renders children', () => {
    renderLayout(<p>Test child content</p>);
    expect(screen.getByText('Test child content')).toBeInTheDocument();
  });

  it('renders mobile channels button', () => {
    renderLayout();
    expect(screen.getByLabelText('Open channels')).toBeInTheDocument();
  });

  it('lets the mobile top bar and search fill the full viewport width', () => {
    const { container } = renderLayout();

    const header = container.querySelector('header')!;
    const searchShell = screen.getByLabelText('Search').closest('header')!.querySelector('div')!;
    expect(header).toHaveClass('grid', 'w-full', 'grid-cols-[2.75rem_minmax(0,1fr)_2.75rem]');
    expect(searchShell).toHaveClass('w-full', 'max-w-2xl', 'justify-self-center', 'lg:flex-1');
  });

  it('keeps the desktop sidebar as a persistent rail', () => {
    renderLayout();

    const aside = screen.getByTestId('sidebar').closest('aside')!;
    expect(aside.className).toContain('lg:block');
    expect(aside.className).not.toContain('fixed');
  });

  it('reserves iOS safe-area space above the mobile top bar', () => {
    const { container } = renderLayout();

    const shell = container.querySelector('.pt-\\[env\\(safe-area-inset-top\\)\\]')!;
    expect(shell).toBeInTheDocument();
    expect(shell.className).toContain('bg-[#1a1d21]');
  });

  it('keeps native server switching out of the top bar', () => {
    const resetServer = vi.fn().mockResolvedValue(undefined);
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { ServerNavigation: { resetServer } },
    };

    renderLayout();

    expect(screen.queryByLabelText('Change server')).not.toBeInTheDocument();
    expect(resetServer).not.toHaveBeenCalled();
  });

  it('mobile channels button navigates to channel home', async () => {
    const user = userEvent.setup();
    window.history.pushState({}, '', '/channel/general');
    renderLayout();

    const menuBtn = screen.getByLabelText('Open channels');
    await user.click(menuBtn);

    expect(window.location.pathname).toBe('/');
  });

  it('does not render a mobile side-over overlay', () => {
    const { container } = renderLayout();

    expect(container.querySelector('.bg-black\\/50')).toBeNull();
  });
});
