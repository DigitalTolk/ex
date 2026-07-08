import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadActionBar } from './ThreadActionBar';
import { MessageHitCard } from '@/components/search/MessageHitCard';
import type { SearchHit } from '@/hooks/useSearch';

const LONG_NAME = 'Extraordinarily Long Display Name That Never Seems To End At All';

vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({ map: new Map([['u-long', { id: 'u-long', displayName: LONG_NAME }]]) }),
}));
vi.mock('@/hooks/useEmoji', () => ({ useEmojiMap: () => ({ data: {} }) }));
vi.mock('@/hooks/useMessageParent', () => ({
  useMessageParent: () => ({ label: '~general', href: '/channel/general' }),
}));

// Pixel-geometry regression tests for the mobile overflow sweep: rows that
// must stay on ONE line do (getClientRects().length === 1 is the definitive
// wrapped-text probe), truncation actually truncates instead of pushing the
// row wide, and nothing produces horizontal scroll inside its container.

let active: { unmount: () => Promise<void> } | null = null;
afterEach(async () => {
  if (active) await active.unmount();
  active = null;
});

function qc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const userMap = {
  get: (id: string) => ({ displayName: `User ${id}`, avatarURL: undefined }),
};

describe('thread reply bar geometry', () => {
  async function renderBar(authorIDs: string[], replyCount: number, containerWidth?: number) {
    const result = await render(
      <QueryClientProvider client={qc()}>
        <div style={containerWidth ? { width: containerWidth } : undefined}>
          <ThreadActionBar
            rootMessageID="root-1"
            replyCount={replyCount}
            recentReplyAuthorIDs={authorIDs}
            lastReplyAt="2026-07-01T10:00:00Z"
            onClick={() => undefined}
            userMap={userMap}
          />
        </div>
      </QueryClientProvider>,
    );
    active = result;
    return result;
  }

  it('keeps "N replies" on a single line with 3 avatars (the reported bug)', async () => {
    await renderBar(['u-1', 'u-2', 'u-3'], 4);
    const bar = document.querySelector('[data-testid="thread-action-bar"]') as HTMLElement;
    const label = bar.querySelector('span.whitespace-nowrap') as HTMLElement;
    // A wrapped inline span produces one client rect per line — exactly one
    // rect means exactly one row.
    expect(label.getClientRects().length).toBe(1);
    // The whole bar reads as one row: no taller than avatar height + padding.
    expect(bar.getBoundingClientRect().height).toBeLessThanOrEqual(36);
  });

  it('stays a single row even in a cramped 240px container', async () => {
    await renderBar(['u-1', 'u-2', 'u-3', 'u-4'], 12, 240);
    const bar = document.querySelector('[data-testid="thread-action-bar"]') as HTMLElement;
    const label = bar.querySelector('span.whitespace-nowrap') as HTMLElement;
    expect(label.getClientRects().length).toBe(1);
    expect(bar.getBoundingClientRect().height).toBeLessThanOrEqual(36);
    // And the bar never overflows its container horizontally.
    expect(bar.getBoundingClientRect().width).toBeLessThanOrEqual(240);
  });
});

describe('search hit author name geometry', () => {
  it('truncates a marathon author name instead of widening the row', async () => {
    const hit = {
      id: 'm-1',
      _source: {
        authorId: 'u-long',
        parentId: 'ch-1',
        body: 'hello world',
        createdAt: '2026-07-01T10:00:00Z',
      },
    } as unknown as SearchHit;
    const result = await render(
      <MemoryRouter>
        <QueryClientProvider client={qc()}>
          <div data-testid="hit-frame" style={{ width: 360 }}>
            <MessageHitCard hit={hit} onAuthorClick={() => undefined} />
          </div>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    active = result;
    const frame = document.querySelector('[data-testid="hit-frame"]') as HTMLElement;
    // No horizontal overflow anywhere inside the card at mobile width.
    expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
    const nameEl = frame.querySelector('button[title="Filter results from this person"]') as HTMLElement;
    expect(nameEl.textContent).toBe(LONG_NAME);
    // Truncated to one line, not wrapped or overflowing.
    expect(nameEl.getClientRects().length).toBe(1);
    expect(nameEl.getBoundingClientRect().right).toBeLessThanOrEqual(frame.getBoundingClientRect().right);
  });
});
