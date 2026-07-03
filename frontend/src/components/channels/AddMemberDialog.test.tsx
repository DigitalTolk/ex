import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AddMemberDialog } from './AddMemberDialog';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile }));

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
  beforeEach(() => {
    apiFetchMock.mockReset();
    mockIsMobile = false;
  });

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

  it('requires selecting a user before submitting', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AddMemberDialog open={true} onOpenChange={() => {}} channelId="ch-1" />,
    );
    // The form requires a selectedUser; submitting without one surfaces a hint.
    const input = screen.getByPlaceholderText('Search by name or email...');
    await user.type(input, 'bo');
    // (the native `required` attr blocks a click-submit, so submit the form)
    fireEvent.submit(document.querySelector('form')!);
    expect(await screen.findByText('Please select a user from the search results')).toBeInTheDocument();
  });

  it('shows a generic error when the add request rejects with a non-Error', async () => {
    const user = userEvent.setup();
    apiFetchMock.mockImplementation((_url: string, opts?: { method?: string }) => {
      // The POST to add the member rejects with a non-Error value;
      // the debounced search (no options) resolves with one match.
      if (opts?.method === 'POST') return Promise.reject('boom-string');
      return Promise.resolve([{ id: 'u-9', displayName: 'Bob', email: 'bob@x.com' }]);
    });
    renderWithProviders(
      <AddMemberDialog open={true} onOpenChange={() => {}} channelId="ch-1" />,
    );
    await user.type(screen.getByPlaceholderText('Search by name or email...'), 'bob');
    // Debounced search resolves → result button appears → select it.
    await user.click(await screen.findByText('Bob'));
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText('Failed to add member')).toBeInTheDocument();
  });

  describe('mobile', () => {
    function mobileAction(): HTMLButtonElement {
      const btn = document.querySelector('[data-slot="dialog-mobile-action"]');
      expect(btn).not.toBeNull();
      return btn as HTMLButtonElement;
    }

    it('moves the Add action to the top header, drops the footer, and skips autofocus', () => {
      mockIsMobile = true;
      renderWithProviders(
        <AddMemberDialog open={true} onOpenChange={() => {}} channelId="ch-1" />,
      );
      expect(mobileAction()).toHaveTextContent('Add');
      // Disabled until a user is picked (same gate as the desktop submit).
      expect(mobileAction()).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument();
      // No autofocus: the keyboard shouldn't pop the moment the sheet opens.
      expect(document.activeElement).not.toBe(
        screen.getByPlaceholderText('Search by name or email...'),
      );
    });

    it('adds the selected member via the top-header action', async () => {
      mockIsMobile = true;
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      apiFetchMock.mockImplementation((_url: string, opts?: { method?: string }) => {
        if (opts?.method === 'POST') return Promise.resolve({});
        return Promise.resolve([{ id: 'u-9', displayName: 'Bob', email: 'bob@x.com' }]);
      });
      renderWithProviders(
        <AddMemberDialog open={true} onOpenChange={onOpenChange} channelId="ch-1" />,
      );
      await user.type(screen.getByPlaceholderText('Search by name or email...'), 'bob');
      await user.click(await screen.findByText('Bob'));
      await user.click(mobileAction());
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1/members',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
