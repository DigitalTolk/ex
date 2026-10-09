import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserHoverCard } from '@/components/UserHoverCard';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-me', displayName: 'Me' }, isAuthenticated: true, isLoading: false }),
}));

function renderCard(props: { avatarURL?: string; integrationOwnerName?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UserHoverCard userId="u-1" displayName="Bob" currentUserId="u-me" {...props}>
          <span>trigger</span>
        </UserHoverCard>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UserHoverCard — avatar image in the open card', () => {
  it('mounts nothing of the card while closed, and shows the avatar image once open', () => {
    renderCard({ avatarURL: 'https://cdn.example/bob.png' });
    expect(screen.queryByTestId('hover-card-header')).toBeNull();
    fireEvent.click(screen.getByText('trigger'));
    // jsdom never loads images, so the avatar shows its fallback; the slot
    // itself is what the open card mounts.
    const header = screen.getByTestId('hover-card-header');
    expect(header.querySelector('[data-slot="avatar"]')).not.toBeNull();
    expect(header.textContent).toContain('Bob');
  });

  it('shows the integration variant with its avatar image', () => {
    renderCard({ avatarURL: 'https://cdn.example/bot.png', integrationOwnerName: 'alice' });
    fireEvent.click(screen.getByText('trigger'));
    const card = screen.getByTestId('hover-card-integration');
    expect(card.textContent).toContain('@alice');
    expect(card.querySelector('[data-slot="avatar"]')).not.toBeNull();
  });
});
