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
  it('keeps Edit Profile save as a screen-wide bottom action on mobile', async () => {
    if (window.innerWidth > 767) return;
    const screen = await render(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    const save = screen.getByRole('button', { name: 'Save' }).element();
    await expect.element(save).toBeVisible();

    const rect = save.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(window.innerWidth - 40);
    expect(rect.bottom).toBeGreaterThan(window.innerHeight - 48);
  });

  it('keeps Set Status controls stable and bottom-pinned on mobile', async () => {
    if (window.innerWidth > 767) return;
    const screen = await render(<UserStatusDialog open={true} onOpenChange={vi.fn()} />);

    const statusInput = screen.getByLabelText('Status text').element() as HTMLInputElement;
    const preset = screen.getByLabelText('Predefined status').element() as HTMLSelectElement;
    const clearAfter = screen.getByLabelText('Remove status after').element() as HTMLSelectElement;
    const clear = screen.getByRole('button', { name: 'Clear status' }).element();
    const save = screen.getByRole('button', { name: 'Save status' }).element();

    await expect.element(statusInput).toBeVisible();
    await expect.element(save).toBeVisible();
    expect(Math.abs(statusInput.getBoundingClientRect().height - save.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
    expect(Math.abs(preset.getBoundingClientRect().height - save.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
    expect(Math.abs(clearAfter.getBoundingClientRect().height - save.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
    expect(clear.getBoundingClientRect().bottom).toBeGreaterThan(window.innerHeight - 48);
    expect(save.getBoundingClientRect().bottom).toBeGreaterThan(window.innerHeight - 48);

    const beforeClearAfterBottom = clearAfter.getBoundingClientRect().bottom;
    clearAfter.value = 'custom';
    clearAfter.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(screen.getByLabelText('Custom clear time').element()).toBeVisible();
      expect(save.getBoundingClientRect().bottom).toBeGreaterThan(window.innerHeight - 64);
      expect(clear.getBoundingClientRect().bottom).toBeGreaterThan(window.innerHeight - 64);
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
