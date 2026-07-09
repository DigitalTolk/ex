import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { UpdateBanner } from './UpdateBanner';

const useServerVersionMock = vi.hoisted(() => vi.fn(() => ({ outdated: false })));
vi.mock('@/hooks/useServerVersion', () => ({
  useServerVersion: () => useServerVersionMock(),
}));

describe('UpdateBanner browser behaviour', () => {
  it('renders nothing when the build is current', async () => {
    useServerVersionMock.mockReturnValueOnce({ outdated: false });
    await render(<UpdateBanner />);
    expect(document.querySelector('[data-testid="update-banner"]')).toBeNull();
  });

  it('renders the upgrade banner and reload button when outdated', async () => {
    useServerVersionMock.mockReturnValue({ outdated: true });
    const screen = await render(<UpdateBanner />);
    await expect.element(screen.getByText(/New version available/i)).toBeVisible();
    const btn = document.querySelector('[data-testid="update-banner-reload"]');
    expect(btn).not.toBeNull();
  });

  it('exposes a clickable reload button labeled Reload', async () => {
    useServerVersionMock.mockReturnValue({ outdated: true });
    await render(<UpdateBanner />);
    const btn = document.querySelector('[data-testid="update-banner-reload"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toMatch(/Reload/);
    expect(btn.disabled).toBe(false);
  });
});
