import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberList } from './MemberList';
import type { ChannelMembership } from '@/types';

// Covers the `dismissing ? … : …` className + data-swipe-dismissing arms
// (MemberList lines 101, 103) by driving the swipe hook into its
// mid-dismiss state. The real gesture path is covered separately in
// useAnimatedSwipeDismiss.browser.test; here we only need the consumer's
// truthy branch.
const swipeState = vi.hoisted(() => ({ dismissing: false }));
vi.mock('@/hooks/useAnimatedSwipeDismiss', () => ({
  useAnimatedSwipeDismiss: () => ({
    dismissing: swipeState.dismissing,
    dragOffset: 0,
    dragStyle: undefined,
    swipeHandlers: {},
  }),
}));

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

let active: { unmount: () => Promise<void> | void } | null = null;

beforeEach(() => {
  const style = document.createElement('style');
  style.id = 'kill-anim-ml';
  style.textContent = '*{animation:none!important;transition:none!important}';
  document.head.appendChild(style);
});

afterEach(async () => {
  if (active) await active.unmount();
  active = null;
  swipeState.dismissing = false;
  document.getElementById('kill-anim-ml')?.remove();
});

function member(): ChannelMembership {
  return {
    channelID: 'ch-1',
    userID: 'u-1',
    role: 'member',
    displayName: 'Alice',
    joinedAt: '2026-01-01T00:00:00Z',
  };
}

async function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = await render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MemberList members={[member()]} channelId="ch-1" currentUserId="u-1" currentUserRole={1} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  active = result;
  return result;
}

describe('MemberList swipe-dismiss state', () => {
  it('marks the rail at rest (data-swipe-dismissing=false, no slide-out)', async () => {
    swipeState.dismissing = false;
    await renderList();
    const rail = document.querySelector('[data-mobile-right-sidebar="true"]') as HTMLElement;
    expect(rail.getAttribute('data-swipe-dismissing')).toBe('false');
    expect(rail.className).not.toContain('max-md:translate-x-full');
  });

  it('applies the slide-out class + data-swipe-dismissing=true while dismissing', async () => {
    swipeState.dismissing = true;
    await renderList();
    const rail = document.querySelector('[data-mobile-right-sidebar="true"]') as HTMLElement;
    expect(rail.getAttribute('data-swipe-dismissing')).toBe('true');
    expect(rail.className).toContain('max-md:translate-x-full');
  });
});
