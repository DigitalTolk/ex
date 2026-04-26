import { describe, it, expect, vi } from 'vitest';
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
  it('renders sidebar', () => {
    renderLayout();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('renders children', () => {
    renderLayout(<p>Test child content</p>);
    expect(screen.getByText('Test child content')).toBeInTheDocument();
  });

  it('renders mobile menu button', () => {
    renderLayout();
    expect(screen.getByLabelText('Open sidebar')).toBeInTheDocument();
  });

  it('opens sidebar on mobile menu click', async () => {
    const user = userEvent.setup();
    renderLayout();

    const menuBtn = screen.getByLabelText('Open sidebar');
    await user.click(menuBtn);

    // After clicking, the overlay should appear (a div with aria-hidden)
    // and sidebar should have translate-x-0 class
    const aside = screen.getByTestId('sidebar').closest('aside')!;
    expect(aside.className).toContain('translate-x-0');
  });

  it('closes sidebar when close callback fires', async () => {
    const user = userEvent.setup();
    renderLayout();

    // Open the sidebar first
    await user.click(screen.getByLabelText('Open sidebar'));

    // Click the close button inside our mocked sidebar
    await user.click(screen.getByText('Close sidebar'));

    const aside = screen.getByTestId('sidebar').closest('aside')!;
    expect(aside.className).toContain('-translate-x-full');
  });
});
