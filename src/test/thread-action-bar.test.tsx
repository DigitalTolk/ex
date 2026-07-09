import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { ThreadActionBar } from '@/components/chat/ThreadActionBar';

function renderBar(props: Partial<React.ComponentProps<typeof ThreadActionBar>> = {}) {
  const onClick = props.onClick ?? vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onClick,
    ...render(
      <QueryClientProvider client={qc}>
        <ThreadActionBar
          rootMessageID="root-1"
          replyCount={3}
          recentReplyAuthorIDs={['u1', 'u2']}
          lastReplyAt="2026-04-26T10:30:00Z"
          onClick={onClick}
          {...props}
        />
      </QueryClientProvider>,
    ),
  };
}

describe('ThreadActionBar', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue([
      { id: 'u1', displayName: 'Alice', email: 'a@x.com', avatarURL: 'a.png' },
      { id: 'u2', displayName: 'Bob', email: 'b@x.com' },
    ]);
  });

  it('renders the reply count and is keyboard-focusable button (no underline link)', () => {
    renderBar();
    const bar = screen.getByTestId('thread-action-bar');
    expect(bar.tagName).toBe('BUTTON');
    expect(bar.textContent).toContain('3 replies');
    // Hover styling uses border + bg, NOT underline — locks down the
    // user-reported "looks like a link instead of a button" complaint.
    expect(bar.className).not.toMatch(/underline/);
    expect(bar.className).toMatch(/hover:border/);
    expect(bar.className).toMatch(/hover:bg-muted/);
  });

  it('renders an avatar for each recent reply author', async () => {
    renderBar();
    await waitFor(() => {
      expect(screen.getByTestId('thread-action-avatar-u1')).toBeInTheDocument();
      expect(screen.getByTestId('thread-action-avatar-u2')).toBeInTheDocument();
    });
  });

  it('uses singular "1 reply" when count is one', () => {
    renderBar({ replyCount: 1 });
    expect(screen.getByTestId('thread-action-bar').textContent).toContain('1 reply');
  });

  it('clicking the bar calls onClick with the root message ID', () => {
    const onClick = vi.fn();
    renderBar({ onClick });
    fireEvent.click(screen.getByTestId('thread-action-bar'));
    expect(onClick).toHaveBeenCalledWith('root-1');
  });

  it('omits avatars when no recent authors are known', () => {
    renderBar({ recentReplyAuthorIDs: [] });
    const bar = screen.getByTestId('thread-action-bar');
    expect(bar.querySelectorAll('[data-testid^="thread-action-avatar-"]').length).toBe(0);
  });

  it('always shows a relative last-reply label when a timestamp is present', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    renderBar({ lastReplyAt: fiveMinAgo });
    const label = screen.getByTestId('thread-action-last-reply');
    expect(label.textContent).toMatch(/Last reply 5 minutes ago/);
  });

  it('omits the last-reply label when no timestamp is available', () => {
    renderBar({ lastReplyAt: undefined });
    expect(screen.queryByTestId('thread-action-last-reply')).toBeNull();
  });

  it('falls back to a batch fetch for IDs missing from the providedMap', async () => {
    const partial = new Map([['u1', { displayName: 'Alice', avatarURL: 'a.png' }]]);
    apiFetchMock.mockResolvedValue([
      { id: 'u2', displayName: 'Bob', email: 'b@x.com' },
    ]);
    renderBar({ userMap: partial });
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalled();
    });
    const call = apiFetchMock.mock.calls[0]!;
    expect(call[0]).toBe('/api/v1/users/batch');
    expect(JSON.parse((call[1] as { body: string }).body)).toEqual({ ids: ['u2'] });
  });

  it('skips the fetch when providedMap covers every recent author', () => {
    const full = new Map([
      ['u1', { displayName: 'Alice', avatarURL: 'a.png' }],
      ['u2', { displayName: 'Bob' }],
    ]);
    renderBar({ userMap: full });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
