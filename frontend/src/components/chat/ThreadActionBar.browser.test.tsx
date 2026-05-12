import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadActionBar } from './ThreadActionBar';

vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({ map: new Map(), isLoading: false }),
}));

function renderBar(props: Partial<Parameters<typeof ThreadActionBar>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThreadActionBar
        rootMessageID="root-1"
        replyCount={3}
        recentReplyAuthorIDs={['u-1', 'u-2']}
        lastReplyAt="2026-01-01T00:00:00Z"
        onClick={() => {}}
        userMap={{
          get: (id) => ({ 'u-1': { displayName: 'Alice' }, 'u-2': { displayName: 'Bob' } } as Record<string, { displayName: string }>)[id],
        }}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('ThreadActionBar browser behaviour', () => {
  it('renders the reply count and "replies" plural', async () => {
    const screen = await renderBar();
    await expect.element(screen.getByText(/3 replies/)).toBeVisible();
  });

  it('uses the singular "reply" when replyCount is 1', async () => {
    const screen = await renderBar({ replyCount: 1 });
    await expect.element(screen.getByText(/1 reply/)).toBeVisible();
    expect(document.querySelector('[aria-label="View 1 reply"]')).not.toBeNull();
  });

  it('renders one avatar per recent reply author from the supplied userMap', async () => {
    await renderBar();
    expect(document.querySelector('[data-testid="thread-action-avatar-u-1"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="thread-action-avatar-u-2"]')).not.toBeNull();
  });

  it('renders the last-reply timestamp via formatRelative', async () => {
    const screen = await renderBar({ lastReplyAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    await expect.element(screen.getByText(/Last reply/)).toBeVisible();
  });

  it('omits the last-reply line when lastReplyAt is missing', async () => {
    await renderBar({ lastReplyAt: undefined });
    expect(document.querySelector('[data-testid="thread-action-last-reply"]')).toBeNull();
  });

  it('forwards the rootMessageID to onClick', async () => {
    const onClick = vi.fn();
    await renderBar({ onClick });
    const btn = document.querySelector('[data-testid="thread-action-bar"]') as HTMLButtonElement;
    btn.click();
    expect(onClick).toHaveBeenCalledWith('root-1');
  });
});
