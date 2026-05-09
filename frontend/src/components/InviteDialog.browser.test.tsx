import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { InviteDialog } from './InviteDialog';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

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
});
