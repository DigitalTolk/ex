import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { EditProfileDialog } from './EditProfileDialog';
import { UserStatusDialog } from './UserStatusDialog';
import { AuthProvider } from '@/lib/roles';
import type { User } from '@/types';

const user: User = {
  id: 'u-1',
  email: 'alice@example.test',
  displayName: 'Alice Example',
  systemRole: 'guest',
  authProvider: AuthProvider.Guest,
  status: 'active',
  timeZone: 'UTC',
  userStatus: {
    emoji: ':house:',
    text: 'Working from home',
  },
};

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user,
    setAuth: vi.fn(),
  }),
}));

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'light',
    setTheme: vi.fn(),
  }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getAccessToken: vi.fn(() => 'token'),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

describe('Mobile user dialog browser behavior', () => {
  it('surfaces the Edit Profile save in the top-right header on mobile (not a bottom bar)', async () => {
    if (window.innerWidth > 767) return;
    const screen = await render(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    const save = screen.getByRole('button', { name: 'Save' }).element();
    await expect.element(save).toBeVisible();

    // The save now lives in the dialog's top-right action cluster, near the
    // top of the screen, so the keyboard can't cover it.
    expect(save.closest('[data-slot="dialog-mobile-actions"]')).not.toBeNull();
    const rect = save.getBoundingClientRect();
    expect(rect.top).toBeLessThan(window.innerHeight / 2);
    // It's a compact control, not a screen-wide bottom button.
    expect(rect.width).toBeLessThan(window.innerWidth - 40);
  });

  it('surfaces the Set Status save in the top-right header and keeps the controls stable on mobile', async () => {
    if (window.innerWidth > 767) return;
    const screen = await render(<UserStatusDialog open={true} onOpenChange={vi.fn()} />);

    const statusInput = screen.getByLabelText('Status text').element() as HTMLInputElement;
    const preset = screen.getByLabelText('Predefined status').element() as HTMLSelectElement;
    const clearAfter = screen.getByLabelText('Remove status after').element() as HTMLSelectElement;
    const save = screen.getByRole('button', { name: 'Save status' }).element();

    await expect.element(statusInput).toBeVisible();
    await expect.element(save).toBeVisible();
    // Save lives in the top-right header cluster.
    expect(save.closest('[data-slot="dialog-mobile-actions"]')).not.toBeNull();
    expect(save.getBoundingClientRect().top).toBeLessThan(window.innerHeight / 2);
    // The three controls keep matching heights (unchanged layout).
    expect(Math.abs(preset.getBoundingClientRect().height - statusInput.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
    expect(Math.abs(clearAfter.getBoundingClientRect().height - statusInput.getBoundingClientRect().height)).toBeLessThanOrEqual(1);

    const beforeClearAfterBottom = clearAfter.getBoundingClientRect().bottom;
    clearAfter.value = 'custom';
    clearAfter.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(screen.getByLabelText('Custom clear time').element()).toBeVisible();
      // Revealing the custom-time row pushes content down a little but doesn't
      // shift the existing clearAfter control.
      expect(Math.abs(clearAfter.getBoundingClientRect().bottom - beforeClearAfterBottom)).toBeLessThanOrEqual(4);
    });

    const root = document.scrollingElement ?? document.documentElement;
    root.scrollTop = 0;
    statusInput.focus();
    await vi.waitFor(() => {
      expect(root.scrollTop).toBe(0);
      expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1);
    });
  });
});
