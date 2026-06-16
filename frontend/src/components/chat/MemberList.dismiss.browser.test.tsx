import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberList } from './MemberList';
import type { ChannelMembership } from '@/types';

// Covers both arms of the data-swipe-dismissing attribute by driving the
// Motion swipe hook into its mid-dismiss state. The drag physics are
// unit-tested in useSwipeDismiss.test.
const swipeState = vi.hoisted(() => ({ dismissing: false, settled: true }));
vi.mock('@/hooks/useSwipeDismiss', () => ({
  useSwipeDismiss: () => ({ dismissing: swipeState.dismissing, settled: swipeState.settled, motionProps: {} }),
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
  it('marks the rail at rest (data-swipe-dismissing=false)', async () => {
    swipeState.dismissing = false;
    await renderList();
    const rail = document.querySelector('[data-mobile-right-sidebar="true"]') as HTMLElement;
    expect(rail.getAttribute('data-swipe-dismissing')).toBe('false');
  });

  it('marks the rail data-swipe-dismissing=true while dismissing', async () => {
    swipeState.dismissing = true;
    await renderList();
    const rail = document.querySelector('[data-mobile-right-sidebar="true"]') as HTMLElement;
    expect(rail.getAttribute('data-swipe-dismissing')).toBe('true');
  });
});
