import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AddMemberDialog } from './AddMemberDialog';

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe('AddMemberDialog', () => {
  it('renders form when open', () => {
    renderWithProviders(
      <AddMemberDialog open={true} onOpenChange={() => {}} channelId="ch-1" />,
    );

    expect(screen.getByRole('heading', { name: 'Add member' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add member' })).toBeInTheDocument();
  });

  it('shows search input', () => {
    renderWithProviders(
      <AddMemberDialog open={true} onOpenChange={() => {}} channelId="ch-1" />,
    );

    expect(screen.getByPlaceholderText('Search by name or email...')).toBeInTheDocument();
  });
});
