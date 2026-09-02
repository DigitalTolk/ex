import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

let mockUser: { id: string; email: string; systemRole: string } | null = null;
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, isAuthenticated: !!mockUser, isLoading: false }),
}));

import { EmailAdminPanel } from '@/components/admin/EmailAdminPanel';

function wrap(children: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(<QueryClientProvider client={qc}>{children}</QueryClientProvider>);
}

const configured = { configured: true, provider: 'smtp', from: 'Ex <noreply@example.com>' };

beforeEach(() => {
  apiFetchMock.mockReset();
  mockUser = { id: 'u-admin', email: 'admin@example.com', systemRole: 'admin' };
});

describe('EmailAdminPanel', () => {
  it('shows the effective transport so a test result can be interpreted', async () => {
    apiFetchMock.mockResolvedValueOnce(configured);
    wrap(<EmailAdminPanel />);

    expect((await screen.findByTestId('email-provider')).textContent).toBe('smtp');
    expect(screen.getByTestId('email-from').textContent).toBe('Ex <noreply@example.com>');
  });

  // An admin must be able to tell "email is off" from "email is broken".
  it('explains the unconfigured case and offers no send button', async () => {
    apiFetchMock.mockResolvedValueOnce({ configured: false, provider: 'smtp', from: '' });
    wrap(<EmailAdminPanel />);

    expect(await screen.findByTestId('email-unconfigured')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /send test email/i }),
    ).not.toBeInTheDocument();
  });

  it('sends to an explicit recipient and confirms', async () => {
    apiFetchMock.mockResolvedValueOnce(configured);
    const user = userEvent.setup();
    wrap(<EmailAdminPanel />);
    await screen.findByTestId('email-provider');

    apiFetchMock.mockResolvedValueOnce({
      sent: true, to: 'ops@example.com', provider: 'smtp', from: 'Ex <noreply@example.com>',
    });
    await user.type(screen.getByLabelText(/send a test message to/i), 'ops@example.com');
    await user.click(screen.getByRole('button', { name: /send test email/i }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/admin/email/test', {
        method: 'POST',
        body: JSON.stringify({ to: 'ops@example.com' }),
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/sent to ops@example\.com/i);
  });

  // Blank means "send to me" — the server falls back to the caller's address.
  it('sends an empty recipient so the server uses the calling admin', async () => {
    apiFetchMock.mockResolvedValueOnce(configured);
    const user = userEvent.setup();
    wrap(<EmailAdminPanel />);
    await screen.findByTestId('email-provider');

    apiFetchMock.mockResolvedValueOnce({
      sent: true, to: 'admin@example.com', provider: 'smtp', from: 'Ex <noreply@example.com>',
    });
    await user.click(screen.getByRole('button', { name: /send test email/i }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/admin/email/test', {
        method: 'POST',
        body: JSON.stringify({ to: '' }),
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/sent to admin@example\.com/i);
    expect(screen.getByText(/leave blank to send to admin@example\.com/i)).toBeInTheDocument();
  });

  // The transport's own error is the whole value of the feature: without it an
  // admin cannot tell a wrong password from an unreachable host.
  it('surfaces the transport error verbatim', async () => {
    apiFetchMock.mockResolvedValueOnce(configured);
    const user = userEvent.setup();
    wrap(<EmailAdminPanel />);
    await screen.findByTestId('email-provider');

    apiFetchMock.mockRejectedValueOnce(
      new Error('email: smtp send: dial tcp 10.0.0.1:587: connect: connection refused'),
    );
    await user.click(screen.getByRole('button', { name: /send test email/i }));

    const err = await screen.findByTestId('test-email-error');
    expect(err).toHaveTextContent(/connection refused/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/sending failed/i);
  });

  it('falls back to a generic message for a non-Error rejection', async () => {
    apiFetchMock.mockResolvedValueOnce(configured);
    const user = userEvent.setup();
    wrap(<EmailAdminPanel />);
    await screen.findByTestId('email-provider');

    apiFetchMock.mockRejectedValueOnce('offline');
    await user.click(screen.getByRole('button', { name: /send test email/i }));

    expect(await screen.findByTestId('test-email-error')).toHaveTextContent(/unknown error/i);
  });

  it('reports a failure to load the status', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('admin only'));
    wrap(<EmailAdminPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/admin only/i);
  });

  it('reports a non-Error status failure', async () => {
    apiFetchMock.mockRejectedValueOnce('boom');
    wrap(<EmailAdminPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not load email status/i,
    );
  });

  it('shows a loading state first', () => {
    apiFetchMock.mockReturnValueOnce(new Promise(() => {}));
    wrap(<EmailAdminPanel />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('disables the button while the send is in flight', async () => {
    apiFetchMock.mockResolvedValueOnce(configured);
    const user = userEvent.setup();
    wrap(<EmailAdminPanel />);
    await screen.findByTestId('email-provider');

    // Never resolves: the button must stay disabled rather than allow a
    // double-send against a slow relay.
    apiFetchMock.mockReturnValueOnce(new Promise(() => {}));
    await user.click(screen.getByRole('button', { name: /send test email/i }));

    const button = await screen.findByRole('button', { name: /sending/i });
    expect(button).toBeDisabled();
  });

  // The session can lapse while the page is open; the panel must still render
  // rather than blow up on a missing address.
  it('renders without a signed-in user', async () => {
    mockUser = null;
    apiFetchMock.mockResolvedValueOnce(configured);
    wrap(<EmailAdminPanel />);

    await screen.findByTestId('email-provider');
    expect(screen.getByText(/leave blank to send to your own address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/send a test message to/i)).toHaveAttribute(
      'placeholder',
      'you@example.com',
    );
  });
});
