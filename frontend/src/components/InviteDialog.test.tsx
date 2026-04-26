import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InviteDialog } from './InviteDialog';

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    apiFetch: vi.fn(),
    ApiError: MockApiError,
  };
});

describe('InviteDialog', () => {
  it('renders email input and submit button when open', () => {
    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send invitation/i })).toBeInTheDocument();
  });

  it('renders dialog title', () => {
    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText('Invite someone')).toBeInTheDocument();
  });

  it('does not render content when closed', () => {
    render(<InviteDialog open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
  });

  it('has email input with correct type', () => {
    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    const emailInput = screen.getByLabelText(/email address/i);
    expect(emailInput).toHaveAttribute('type', 'email');
  });

  it('shows placeholder text in email input', () => {
    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByPlaceholderText('colleague@example.com')).toBeInTheDocument();
  });
});
