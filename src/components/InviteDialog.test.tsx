import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile }));

describe('InviteDialog', () => {
  beforeEach(() => {
    mockIsMobile = false;
  });

  it('renders email input and submit button when open', () => {
    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send invitation/i })).toBeInTheDocument();
  });

  it('on mobile, sends from the top-right header action instead of an inline submit', async () => {
    mockIsMobile = true;
    const { apiFetch } = await import('@/lib/api');
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ token: 'tok-1' });
    const user = userEvent.setup();
    render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText(/email address/i), 'colleague@example.com');
    const send = screen.getByRole('button', { name: 'Send invitation' });
    expect(send.closest('[data-slot="dialog-mobile-actions"]')).not.toBeNull();
    await user.click(send);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/auth/invite', expect.objectContaining({ method: 'POST' })),
    );
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
