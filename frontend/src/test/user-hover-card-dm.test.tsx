import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

function setMobileMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

function swipeDown(element: Element) {
  fireEvent.touchStart(element, { touches: [{ clientX: 160, clientY: 120 }] });
  fireEvent.touchMove(element, { touches: [{ clientX: 168, clientY: 230 }] });
  fireEvent.touchEnd(element, { changedTouches: [{ clientX: 168, clientY: 230 }] });
}

describe('UserHoverCard — click-to-open + DM action', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    setMobileMatch(false);
  });

  it('opens on click and queries the user record', async () => {
    apiFetchMock.mockResolvedValue({
      id: 'u-other',
      displayName: 'Bob',
      status: 'active',
    });
    renderCard({ online: true });
    fireEvent.click(screen.getByText('trigger'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Direct message/i })).toBeInTheDocument();
    });
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/users/u-other');
    expect(screen.getByLabelText('Online')).toBeInTheDocument();
  });

  it('does not open on mouseEnter (hover-to-open is disabled)', () => {
    apiFetchMock.mockResolvedValue({ id: 'u-other', displayName: 'Bob', status: 'active' });
    renderCard();
    fireEvent.mouseEnter(screen.getByText('trigger'));
    expect(screen.queryByRole('button', { name: /Direct message/i })).toBeNull();
    // /api/v1/users is gated on `open`, so the absence of any fetch is
    // also a strong signal that the popover stayed closed.
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('toggles closed when the trigger is clicked a second time', async () => {
    apiFetchMock.mockResolvedValue({ id: 'u-other', displayName: 'Bob', status: 'active' });
    renderCard();
    fireEvent.click(screen.getByText('trigger'));
    await screen.findByRole('button', { name: /Direct message/i });
    fireEvent.click(screen.getByText('trigger'));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Direct message/i })).toBeNull();
    });
  });

  it('closes the mobile hover card on swipe down', async () => {
    setMobileMatch(true);
    apiFetchMock.mockResolvedValue({ id: 'u-other', displayName: 'Bob', status: 'active' });
    renderCard();
    fireEvent.click(screen.getByText('trigger'));
    const dialog = await screen.findByRole('tooltip');

    swipeDown(dialog);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Direct message/i })).toBeNull();
    });
  });

  it('hides the Direct message button when viewing your own card', async () => {
    apiFetchMock.mockResolvedValue({ id: 'u-me', displayName: 'Bob', status: 'active' });
    renderCard({ userId: 'u-me', currentUserId: 'u-me' });
    fireEvent.click(screen.getByText('trigger'));
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
    fireEvent.click(screen.getByText('trigger'));
    const dm = await screen.findByRole('button', { name: /Direct message/i });
    fireEvent.click(dm);
    await waitFor(() => {
      expect(screen.getByTestId('conv-page')).toBeInTheDocument();
    });
    const postCall = apiFetchMock.mock.calls.find((c) => c[0] === '/api/v1/conversations');
    expect(postCall).toBeDefined();
    expect(JSON.parse(postCall![1].body)).toEqual({
      type: 'dm',
      participantIDs: ['u-other'],
    });
  });
});
