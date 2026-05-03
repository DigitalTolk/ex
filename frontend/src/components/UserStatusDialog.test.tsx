import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserStatusDialog } from './UserStatusDialog';

const apiFetchMock = vi.fn();
const setAuthMock = vi.fn();
const activeUser = {
  id: 'u-1',
  email: 'u@example.com',
  displayName: 'User',
  systemRole: 'member' as const,
  status: 'active',
  timeZone: 'UTC',
  userStatus: undefined as { emoji: string; text: string; clearAt?: string } | undefined,
};
let authUser: typeof activeUser | null = activeUser;
let accessToken: string | null = 'token';

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getAccessToken: () => accessToken,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: authUser,
    setAuth: setAuthMock,
  }),
}));

vi.mock('@/components/EmojiPicker', () => ({
  EmojiPicker: ({ onSelect, trigger }: { onSelect: (emoji: string) => void; trigger: ReactNode }) =>
    isValidElement<{ onClick?: () => void }>(trigger)
      ? cloneElement(trigger, { onClick: () => onSelect(':tada:') })
      : <button type="button" onClick={() => onSelect(':tada:')}>{trigger}</button>,
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

describe('UserStatusDialog', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    setAuthMock.mockReset();
    accessToken = 'token';
    authUser = { ...activeUser, userStatus: undefined };
  });

  afterEach(() => {
    document.body.removeAttribute('style');
  });

  it('saves a preset status with its default clear time', async () => {
    apiFetchMock.mockResolvedValue({
      id: 'u-1',
      email: 'u@example.com',
      displayName: 'User',
      systemRole: 'member',
      status: 'active',
      userStatus: { emoji: ':sandwich:', text: 'Out for Lunch' },
    });

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/Predefined status/i), 'Out for Lunch');
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/users/me/status', expect.objectContaining({ method: 'PATCH' }));
    });
    const body = JSON.parse(apiFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ emoji: ':sandwich:', text: 'Out for Lunch' });
    expect(body.clearAt).toEqual(expect.any(String));
    expect(setAuthMock).toHaveBeenCalled();
  });

  it('uses a dropdown for predefined statuses and keeps the modal height stable', () => {
    render(<UserStatusDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText(/Predefined status/i)).toHaveValue('__custom__');
    expect(screen.getByTestId('user-status-dialog-body')).toHaveClass('min-h-[340px]');
  });

  it('uses end of today for sick and work-from-home presets', async () => {
    apiFetchMock.mockResolvedValue({ ...activeUser, userStatus: { emoji: ':face_thermo:', text: 'Out Sick' } });

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/Predefined status/i), 'Out Sick');
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const sickBody = JSON.parse(apiFetchMock.mock.calls[0][1].body);
    expect(sickBody).toMatchObject({ emoji: ':face_thermo:', text: 'Out Sick' });
    expect(sickBody.clearAt).toEqual(expect.any(String));

    apiFetchMock.mockClear();
    await userEvent.selectOptions(screen.getByLabelText(/Predefined status/i), 'Working from home');
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const wfhBody = JSON.parse(apiFetchMock.mock.calls[0][1].body);
    expect(wfhBody).toMatchObject({ emoji: ':house:', text: 'Working from home' });
    expect(wfhBody.clearAt).toEqual(expect.any(String));
  });

  it('uses the one-hour default for meetings', async () => {
    apiFetchMock.mockResolvedValue({
      ...activeUser,
      userStatus: { emoji: ':spiral_calendar:', text: 'In a meeting' },
    });

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/Predefined status/i), 'In a meeting');
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const body = JSON.parse(apiFetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ emoji: ':spiral_calendar:', text: 'In a meeting' });
    expect(body.clearAt).toEqual(expect.any(String));
  });

  it('supports custom emoji, custom text, and no automatic clear', async () => {
    apiFetchMock.mockResolvedValue({
      id: 'u-1',
      email: 'u@example.com',
      displayName: 'User',
      systemRole: 'member',
      status: 'active',
      userStatus: { emoji: ':tada:', text: 'Shipping' },
    });

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/Choose status emoji/i));
    await userEvent.clear(screen.getByLabelText(/Status text/i));
    await userEvent.type(screen.getByLabelText(/Status text/i), 'Shipping');
    await userEvent.selectOptions(screen.getByLabelText(/Remove status after/i), "Don't clear");
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const body = JSON.parse(apiFetchMock.mock.calls[0][1].body);
    expect(body.emoji).toBe(':tada:');
    expect(body.text).toBe('Shipping');
    expect(body.clearAt).toBeUndefined();
  });

  it('saves a custom clear time', async () => {
    apiFetchMock.mockResolvedValue({ ...activeUser, userStatus: { emoji: ':tada:', text: 'Deploying' } });

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/Predefined status/i), 'On Vacation');
    await userEvent.clear(screen.getByLabelText(/Status text/i));
    await userEvent.type(screen.getByLabelText(/Status text/i), 'Deploying');
    await userEvent.selectOptions(screen.getByLabelText(/Remove status after/i), 'Custom time');
    fireEvent.change(screen.getByLabelText(/Custom clear time/i), { target: { value: '2030-05-03T12:30' } });
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const body = JSON.parse(apiFetchMock.mock.calls[0][1].body);
    expect(body.clearAt).toBe('2030-05-03T12:30:00.000Z');
  });

  it('omits an invalid custom clear time', async () => {
    apiFetchMock.mockResolvedValue({ ...activeUser, userStatus: { emoji: ':palm_tree:', text: 'On Vacation' } });

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/Predefined status/i), 'On Vacation');
    await userEvent.selectOptions(screen.getByLabelText(/Remove status after/i), 'Custom time');
    fireEvent.change(screen.getByLabelText(/Custom clear time/i), { target: { value: '' } });
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const body = JSON.parse(apiFetchMock.mock.calls[0][1].body);
    expect(body.clearAt).toBeUndefined();
  });

  it('initializes from an existing status with a clear time', () => {
    authUser = {
      ...activeUser,
      timeZone: 'America/New_York',
      userStatus: { emoji: ':house:', text: 'Working from home', clearAt: '2030-05-03T12:30:00.000Z' },
    };

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText(/Status text/i)).toHaveValue('Working from home');
    expect(screen.getByLabelText(/Predefined status/i)).toHaveValue('Working from home');
    expect(screen.getByLabelText(/Remove status after/i)).toHaveValue('today');
  });

  it('shows custom clear time in the user timezone', () => {
    authUser = {
      ...activeUser,
      timeZone: 'America/New_York',
      userStatus: { emoji: ':tada:', text: 'Deploying', clearAt: '2030-05-03T12:30:00.000Z' },
    };

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText(/Remove status after/i)).toHaveValue('custom');
    expect(screen.getByLabelText(/Custom clear time/i)).toHaveValue('2030-05-03T08:30');
  });

  it('resets unsaved edits when closed and reopened', async () => {
    const { rerender } = render(<UserStatusDialog open onOpenChange={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/Predefined status/i), 'Out for Lunch');
    expect(screen.getByLabelText(/Status text/i)).toHaveValue('Out for Lunch');

    rerender(<UserStatusDialog open={false} onOpenChange={vi.fn()} />);
    rerender(<UserStatusDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText(/Predefined status/i)).toHaveValue('__custom__');
    expect(screen.getByLabelText(/Status text/i)).toHaveValue('');
    expect(screen.queryByLabelText(/Custom clear time/i)).not.toBeInTheDocument();
  });

  it('keeps custom preset selected when existing status is not a predefined status', () => {
    authUser = {
      ...activeUser,
      userStatus: { emoji: ':tada:', text: 'Deploying', clearAt: '2030-05-03T12:30:00.000Z' },
    };

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText(/Predefined status/i)).toHaveValue('__custom__');
    expect(screen.getByLabelText(/Custom clear time/i)).toBeInTheDocument();
  });

  it('clears the current status', async () => {
    authUser = {
      ...activeUser,
      userStatus: { emoji: ':house:', text: 'Working from home' },
    };
    apiFetchMock.mockResolvedValue({
      id: 'u-1',
      email: 'u@example.com',
      displayName: 'User',
      systemRole: 'member',
      status: 'active',
    });

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Clear status/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/users/me/status', expect.objectContaining({ method: 'DELETE' }));
    });
  });

  it('shows a validation error when status text is empty', async () => {
    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/Choose an emoji and status text/);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('limits custom status text to 32 characters before saving', async () => {
    render(<UserStatusDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText(/Status text/i)).toHaveAttribute('maxLength', '32');
    fireEvent.change(screen.getByLabelText(/Status text/i), { target: { value: 'x'.repeat(33) } });
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/32 characters or fewer/);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('shows a friendly error when saving fails', async () => {
    apiFetchMock.mockRejectedValue(new Error('Status service unavailable'));

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/Predefined status/i), 'Out for Lunch');
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Status service unavailable/);
  });

  it('shows a friendly fallback error when saving fails without an Error object', async () => {
    apiFetchMock.mockRejectedValue('nope');

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/Predefined status/i), 'Out for Lunch');
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to save status/);
  });

  it('shows a friendly fallback error when clearing fails', async () => {
    authUser = { ...activeUser, userStatus: { emoji: ':house:', text: 'Working from home' } };
    apiFetchMock.mockRejectedValue('nope');

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Clear status/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to clear status/);
  });

  it('shows the clear error message when clearing fails with an Error object', async () => {
    authUser = { ...activeUser, userStatus: { emoji: ':house:', text: 'Working from home' } };
    apiFetchMock.mockRejectedValue(new Error('Clear failed'));

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Clear status/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Clear failed/);
  });

  it('closes without saving when cancelled', async () => {
    const onOpenChange = vi.fn();

    render(<UserStatusDialog open onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('does not update auth when no token is available', async () => {
    accessToken = null;
    apiFetchMock.mockResolvedValue({ ...activeUser, userStatus: { emoji: ':sandwich:', text: 'Out for Lunch' } });

    render(<UserStatusDialog open onOpenChange={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/Predefined status/i), 'Out for Lunch');
    await userEvent.click(screen.getByRole('button', { name: /Save status/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(setAuthMock).not.toHaveBeenCalled();
  });

  it('renders nothing without an authenticated user', () => {
    authUser = null;
    const { container } = render(<UserStatusDialog open onOpenChange={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });
});
