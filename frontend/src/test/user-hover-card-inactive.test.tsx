import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserHoverCard } from '@/components/UserHoverCard';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function renderCard(userId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <UserHoverCard userId={userId} displayName="Disabled User">
          <span>trigger</span>
        </UserHoverCard>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('UserHoverCard — inactive guest indicator', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.useFakeTimers();
  });

  it('shows the Inactive badge when the fetched user has status=deactivated', async () => {
    apiFetchMock.mockResolvedValue({
      id: 'u-disabled',
      displayName: 'Disabled User',
      status: 'deactivated',
    });
    renderCard('u-disabled');
    fireEvent.mouseEnter(screen.getByText('trigger'));
    // Show delay
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
    await waitFor(() => {
      expect(screen.getByTestId('hover-status-inactive')).toBeInTheDocument();
    });
  });

  it('does not render the Inactive badge for active users', async () => {
    apiFetchMock.mockResolvedValue({
      id: 'u-active',
      displayName: 'Active User',
      status: 'active',
    });
    renderCard('u-active');
    fireEvent.mouseEnter(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
    await waitFor(() => {
      // Wait for the popover to render.
      expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/users/u-active');
    });
    expect(screen.queryByTestId('hover-status-inactive')).toBeNull();
  });
});
