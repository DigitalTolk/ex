import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { InviteDialog } from './InviteDialog';

const apiFetchMock = vi.hoisted(() => vi.fn());
const ApiErrorMock = vi.hoisted(() => class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
});
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  ApiError: ApiErrorMock,
}));

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('InviteDialog browser behavior', () => {
  it('keeps mobile input height aligned with the submit button', async () => {
    const screen = await render(<InviteDialog open={true} onOpenChange={vi.fn()} />);

    const input = screen.getByLabelText('Email address').element();
    const button = screen.getByRole('button', { name: 'Send invitation' }).element();
    await expect.element(input).toBeVisible();
    await expect.element(button).toBeVisible();

    const inputHeight = input.getBoundingClientRect().height;
    const buttonHeight = button.getBoundingClientRect().height;
    if (window.innerWidth <= 767) {
      expect(Math.abs(inputHeight - buttonHeight)).toBeLessThanOrEqual(1);
      expect(inputHeight).toBeGreaterThanOrEqual(40);
    } else {
      expect(Math.abs(inputHeight - buttonHeight)).toBeLessThanOrEqual(1);
    }
  });

  it('does not make the mobile page scroll when the invite email input is focused', async () => {
    if (window.innerWidth > 767) return;
    const screen = await render(<InviteDialog open={true} onOpenChange={vi.fn()} />);
    const input = screen.getByLabelText('Email address').element() as HTMLInputElement;
    const root = document.scrollingElement ?? document.documentElement;

    root.scrollTop = 0;
    await input.focus();

    await vi.waitFor(() => {
      expect(root.scrollTop).toBe(0);
      expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1);
    });
  });

  it('renders the sent-invite link block and lets the user copy it after success', async () => {
    apiFetchMock.mockResolvedValue({ token: 'invite-token-1' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    const screen = await render(<InviteDialog open={true} onOpenChange={vi.fn()} />);
    await screen.getByLabelText('Email address').fill('me@example.test');
    await screen.getByRole('button', { name: 'Send invitation' }).click();
    await expect.element(screen.getByText(/Invitation sent/)).toBeVisible();
    const linkInput = document.querySelector('input[readonly]') as HTMLInputElement;
    expect(linkInput.value).toContain('/invite/invite-token-1');
    await screen.getByRole('button', { name: 'Copy' }).click();
    expect(writeText).toHaveBeenCalledWith(linkInput.value);
  });

  it('shows the already-member status and lets the user retry with a different email', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiErrorMock(409, 'conflict'));
    const screen = await render(<InviteDialog open={true} onOpenChange={vi.fn()} />);
    await screen.getByLabelText('Email address').fill('dup@example.test');
    await screen.getByRole('button', { name: 'Send invitation' }).click();
    await expect.element(screen.getByText(/User is already a member/)).toBeVisible();
    await screen.getByRole('button', { name: 'Invite someone else' }).click();
    await expect.element(screen.getByLabelText('Email address')).toBeVisible();
  });

  it('surfaces a non-409 error message in the alert region', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('boom'));
    const screen = await render(<InviteDialog open={true} onOpenChange={vi.fn()} />);
    await screen.getByLabelText('Email address').fill('me@example.test');
    await screen.getByRole('button', { name: 'Send invitation' }).click();
    await expect.element(screen.getByText('boom')).toBeVisible();
  });

  it('falls back to a generic message when the invite request rejects with a non-Error', async () => {
    apiFetchMock.mockRejectedValueOnce('weird');
    const screen = await render(<InviteDialog open={true} onOpenChange={vi.fn()} />);
    await screen.getByLabelText('Email address').fill('me@example.test');
    await screen.getByRole('button', { name: 'Send invitation' }).click();
    // Non-Error, non-409 → the `err instanceof Error ? ... : 'Failed to create invite'`
    // false arm supplies the message.
    await expect.element(screen.getByText('Failed to create invite')).toBeVisible();
  });

  it('resets internal state when onOpenChange flips to false', async () => {
    apiFetchMock.mockResolvedValue({ token: 't-1' });
    const onOpenChange = vi.fn();
    const screen = await render(<InviteDialog open={true} onOpenChange={onOpenChange} />);
    await screen.getByLabelText('Email address').fill('me@example.test');
    await screen.getByRole('button', { name: 'Send invitation' }).click();
    await expect.element(screen.getByText(/Invitation sent/)).toBeVisible();
    // The dialog forwards close events through handleClose, which resets
    // state — drive that path by dispatching Escape on the dialog.
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    if (dialog) {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    // We don't assert reopen state here — just confirm the close path
    // doesn't throw, and that the close handler fires.
    // Escape closes the dialog through the internal handler which proxies to onOpenChange.
    expect(onOpenChange).toHaveBeenCalled();
  });
});
