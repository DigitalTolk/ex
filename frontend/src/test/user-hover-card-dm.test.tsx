import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserHoverCard } from '@/components/UserHoverCard';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function renderCard(opts: {
  userId?: string;
  currentUserId?: string;
  online?: boolean;
} = {}) {
  const { userId = 'u-other', currentUserId = 'u-me', online } = opts;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <UserHoverCard
                userId={userId}
                displayName="Bob"
                online={online}
                currentUserId={currentUserId}
              >
                <span>trigger</span>
              </UserHoverCard>
            }
          />
          <Route path="/conversation/:id" element={<div data-testid="conv-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UserHoverCard — DM action and presence', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.useFakeTimers();
  });

  it('renders the popover after the show delay and queries the user record', async () => {
    apiFetchMock.mockResolvedValue({
      id: 'u-other',
      displayName: 'Bob',
      status: 'active',
    });
    renderCard({ online: true });
    fireEvent.mouseEnter(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Direct message/i })).toBeInTheDocument();
    });
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/users/u-other');
    // Online indicator appears
    expect(screen.getByLabelText('Online')).toBeInTheDocument();
  });

  it('hides the Direct message button when viewing your own card', async () => {
    apiFetchMock.mockResolvedValue({ id: 'u-me', displayName: 'Bob', status: 'active' });
    renderCard({ userId: 'u-me', currentUserId: 'u-me' });
    fireEvent.mouseEnter(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
    // Wait until the avatar fallback (initials of displayName) shows up,
    // which only happens once the popover has rendered.
    await waitFor(() => {
      expect(document.querySelector('[class*="bg-popover"]')).not.toBeNull();
    });
    expect(screen.queryByRole('button', { name: /Direct message/i })).toBeNull();
  });

  it('clicking Direct message creates a conversation and navigates to it', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ id: 'u-other', displayName: 'Bob', status: 'active' })
      .mockResolvedValueOnce({ id: 'conv-77' });
    renderCard();
    fireEvent.mouseEnter(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
    const dm = await screen.findByRole('button', { name: /Direct message/i });
    fireEvent.click(dm);
    await waitFor(() => {
      expect(screen.getByTestId('conv-page')).toBeInTheDocument();
    });
    // Verify the POST body shape
    const postCall = apiFetchMock.mock.calls.find((c) => c[0] === '/api/v1/conversations');
    expect(postCall).toBeDefined();
    expect(JSON.parse(postCall![1].body)).toEqual({
      type: 'dm',
      participantIDs: ['u-other'],
    });
  });

  it('mouseLeave before the show delay never opens the popover', () => {
    apiFetchMock.mockResolvedValue({ id: 'u-other', displayName: 'Bob', status: 'active' });
    renderCard();
    fireEvent.mouseEnter(screen.getByText('trigger'));
    fireEvent.mouseLeave(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();
    expect(screen.queryByRole('button', { name: /Direct message/i })).toBeNull();
  });

  it('hovering off after open closes the popover after the hide delay', async () => {
    apiFetchMock.mockResolvedValue({ id: 'u-other', displayName: 'Bob', status: 'active' });
    renderCard();
    fireEvent.mouseEnter(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // Now hovered open — leaving fires the hide timer.
    fireEvent.mouseLeave(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Direct message/i })).toBeNull();
    });
  });
});
