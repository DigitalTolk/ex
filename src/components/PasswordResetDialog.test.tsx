import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PasswordResetDialog } from './PasswordResetDialog';
import type { User } from '@/types';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile }));

const guest: User = {
  id: 'u-guest',
  email: 'guest@example.com',
  displayName: 'Guest User',
  systemRole: 'guest',
  authProvider: 'guest',
  status: 'active',
} as User;

async function apiFetchMock() {
  const { apiFetch } = await import('@/lib/api');
  return apiFetch as ReturnType<typeof vi.fn>;
}

describe('PasswordResetDialog', () => {
  beforeEach(async () => {
    mockIsMobile = false;
    (await apiFetchMock()).mockReset();
  });

  it('explains what will happen before anything is created', () => {
    render(<PasswordResetDialog user={guest} onClose={vi.fn()} />);

    expect(screen.getByText(/one-time link for Guest User/i)).toBeInTheDocument();
    expect(
      screen.getByText(/current password keeps working until they choose a new one/i),
    ).toBeInTheDocument();
  });

  it('asks the caller to unmount it when dismissed', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<PasswordResetDialog user={guest} onClose={onClose} />);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('creates the link and reports that it was emailed', async () => {
    const apiFetch = await apiFetchMock();
    apiFetch.mockResolvedValueOnce({
      resetURL: 'https://ex.example.com/reset-password/tok-123',
      expiresAt: '2026-08-11T17:00:00Z',
      emailSent: true,
    });
    const user = userEvent.setup();
    render(<PasswordResetDialog user={guest} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /create reset link/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/v1/users/u-guest/password-reset', {
        method: 'POST',
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      /emailed to guest@example\.com/i,
    );
    expect(screen.getByLabelText('Password reset link')).toHaveValue(
      'https://ex.example.com/reset-password/tok-123',
    );
  });

  // The admin must never be left assuming an email went out when none did.
  it('says the link was not emailed when mail is unconfigured', async () => {
    const apiFetch = await apiFetchMock();
    apiFetch.mockResolvedValueOnce({
      resetURL: 'https://ex.example.com/reset-password/tok-123',
      expiresAt: '2026-08-11T17:00:00Z',
      emailSent: false,
    });
    const user = userEvent.setup();
    render(<PasswordResetDialog user={guest} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /create reset link/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      /email is not configured, so nothing was sent/i,
    );
    // The link is still there to relay by hand.
    expect(screen.getByLabelText('Password reset link')).toHaveValue(
      'https://ex.example.com/reset-password/tok-123',
    );
  });

  it('copies the link to the clipboard', async () => {
    const apiFetch = await apiFetchMock();
    apiFetch.mockResolvedValueOnce({
      resetURL: 'https://ex.example.com/reset-password/tok-123',
      expiresAt: '2026-08-11T17:00:00Z',
      emailSent: true,
    });
    // Spy AFTER setup(): user-event installs its own clipboard stub, so a
    // spy taken earlier would be the one it replaces.
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined);
    render(<PasswordResetDialog user={guest} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /create reset link/i }));
    await user.click(await screen.findByRole('button', { name: 'Copy password reset link' }));

    expect(writeText).toHaveBeenCalledWith('https://ex.example.com/reset-password/tok-123');
  });

  it('surfaces the SSO rejection from the server', async () => {
    const apiFetch = await apiFetchMock();
    apiFetch.mockRejectedValueOnce(
      new Error('password reset is only available for guest accounts'),
    );
    const user = userEvent.setup();
    render(<PasswordResetDialog user={guest} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /create reset link/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /only available for guest accounts/i,
    );
  });

  it('falls back to a generic message for a non-Error rejection', async () => {
    const apiFetch = await apiFetchMock();
    apiFetch.mockRejectedValueOnce('offline');
    const user = userEvent.setup();
    render(<PasswordResetDialog user={guest} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /create reset link/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/failed to create reset link/i);
  });

  it('on mobile, creates from the top-right header action instead of an inline button', async () => {
    mockIsMobile = true;
    const apiFetch = await apiFetchMock();
    apiFetch.mockResolvedValueOnce({
      resetURL: 'https://ex.example.com/reset-password/tok-123',
      expiresAt: '2026-08-11T17:00:00Z',
      emailSent: true,
    });
    const user = userEvent.setup();
    render(<PasswordResetDialog user={guest} onClose={vi.fn()} />);

    expect(
      screen.queryByRole('button', { name: /create reset link/i }),
    ).not.toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create link' });
    expect(create.closest('[data-slot="dialog-mobile-actions"]')).not.toBeNull();

    await user.click(create);
    expect(await screen.findByRole('status')).toHaveTextContent(/emailed to/i);
  });

  it('creates nothing until the admin asks for it', async () => {
    const apiFetch = await apiFetchMock();
    render(<PasswordResetDialog user={guest} onClose={vi.fn()} />);
    // Opening the dialog must not mint a link — the guest's current password
    // keeps working until the admin explicitly acts.
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
