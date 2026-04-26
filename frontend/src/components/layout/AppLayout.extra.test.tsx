import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('AppLayout - overlay close', () => {
  it('clicking the overlay closes the sidebar (line 19)', async () => {
    const user = userEvent.setup();
    const { container } = renderLayout();

    // Open sidebar
    await user.click(screen.getByLabelText('Open sidebar'));

    // Click overlay (the only div with aria-hidden="true")
    const overlay = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay);

    const aside = screen.getByTestId('sidebar').closest('aside')!;
    expect(aside.className).toContain('-translate-x-full');
  });
});
