import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadActionBar } from './ThreadActionBar';

// Mutable so individual tests can seed the fallback /users/batch result
// (the `providedMap.get() ?? fallback.map.get()` arm on line 38).
const fallbackBatch = vi.hoisted(() => ({
  map: new Map<string, { displayName: string; avatarURL?: string }>(),
}));
vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({ map: fallbackBatch.map, isLoading: false }),
}));

beforeEach(() => {
  fallbackBatch.map = new Map();
});

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

  it('renders the avatar image when the resolved author has an avatarURL', async () => {
    // providedMap returns a user WITH an avatarURL → the
    // `u?.avatarURL && <AvatarImage>` arm (line 61) evaluates. Radix only
    // mounts the <img> after the source decodes, so we use a 1x1 PNG data
    // URI (resolves synchronously enough) and wait for it.
    const pixel =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await renderBar({
      recentReplyAuthorIDs: ['u-img'],
      userMap: {
        get: (id) => (id === 'u-img' ? { displayName: 'Imogen', avatarURL: pixel } : undefined),
      },
    });
    const avatar = document.querySelector('[data-testid="thread-action-avatar-u-img"]');
    expect(avatar).not.toBeNull();
    await vi.waitFor(() => {
      expect(avatar!.querySelector('img')).not.toBeNull();
    });
  });

  it('reads through the useUsersBatch fallback for IDs missing from the provided map', async () => {
    // providedMap.get('u-fb') === undefined → line 38 falls through to
    // fallback.map.get('u-fb'), which we seed here.
    fallbackBatch.map = new Map([['u-fb', { displayName: 'Fallback Fran' }]]);
    await renderBar({
      recentReplyAuthorIDs: ['u-fb'],
      userMap: { get: () => undefined },
    });
    // Initials "FF" come from the fallback display name.
    const avatar = document.querySelector('[data-testid="thread-action-avatar-u-fb"]');
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent).toContain('FF');
  });

  it('falls back to "?" initials when neither map resolves the author', async () => {
    // Both providedMap and the (empty) fallback batch return undefined →
    // getInitials(u?.displayName ?? '?') hits the `?? '?'` arm (line 63).
    await renderBar({
      recentReplyAuthorIDs: ['u-ghost'],
      userMap: { get: () => undefined },
    });
    const avatar = document.querySelector('[data-testid="thread-action-avatar-u-ghost"]');
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent).toContain('?');
  });
});
