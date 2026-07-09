import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberList } from './MemberList';
import { swipe } from '@/test/gestures';
import type { ChannelMembership } from '@/types';

// REAL-surface proof for the member rail: MemberList spreads the REAL
// useSwipeDismiss('right', () => onClose?.()) motionProps onto its panel.
// A genuine rightward finger drag past the threshold must animate it
// off-screen and fire onClose; a small below-threshold drag springs back.
// Only the data deps are mocked — useSwipeDismiss (and useIsMobile) run for
// real so Motion's drag engine is exercised via swipe(). The mocked-hook
// branch tests live in MemberList.dismiss.browser.test.tsx; keep both.

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue([]),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

afterEach(() => cleanup());

function member(): ChannelMembership {
  return {
    channelID: 'ch-1',
    userID: 'u-1',
    role: 'member',
    displayName: 'Alice',
    joinedAt: '2026-01-01T00:00:00Z',
  };
}

const rail = () => document.querySelector('[data-mobile-right-sidebar="true"]') as HTMLElement | null;

async function renderList(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MemberList
          members={[member()]}
          channelId="ch-1"
          currentUserId="u-1"
          currentUserRole={1}
          onClose={onClose}
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return onClose;
}

describe('MemberList — real swipe-to-dismiss', () => {
  it('a RIGHT swipe past the threshold closes the member rail', async () => {
    if (window.innerWidth > 767) return; // drag only arms on mobile
    const onClose = await renderList();
    const el = rail();
    expect(el).not.toBeNull();

    // A real rightward drag well past DISMISS_DISTANCE (72px).
    await swipe(el!, { dx: 220, steps: 8, stepMs: 18 });

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('a small RIGHT swipe below the threshold springs back and stays open', async () => {
    if (window.innerWidth > 767) return;
    const onClose = await renderList();
    const el = rail();
    expect(el).not.toBeNull();

    // 40px (< 72px) released slowly (settle → ~0 velocity): stays open.
    await swipe(el!, { dx: 40, steps: 5, stepMs: 24, settle: true });

    await new Promise((r) => setTimeout(r, 60));
    expect(onClose).not.toHaveBeenCalled();
    expect(rail()).not.toBeNull();
  });
});
