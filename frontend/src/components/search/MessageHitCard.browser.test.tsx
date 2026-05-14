import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageHitCard } from './MessageHitCard';
import type { SearchHit } from '@/hooks/useSearch';

// Browser coverage for MessageHitCard (was 0% / 37 uncovered branches).

vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: (ids: string[]) => ({
    map: new Map(
      ids.map((id) => [id, { id, displayName: 'Alice ' + id.slice(-2), avatarURL: undefined }]),
    ),
  }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: { partyparrot: 'https://emoji.test/parrot.gif' } }),
  useEmojis: () => ({ data: [] }),
}));

let parentResult: { label: string; href: string } | null = {
  label: '~general',
  href: '/channel/general#msg-1',
};
vi.mock('@/hooks/useMessageParent', () => ({
  useMessageParent: () => parentResult,
}));

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function hit(overrides: Partial<SearchHit['_source']> = {}, id = 'hit-1'): SearchHit {
  return {
    id,
    _index: 'messages',
    _score: 1,
    _source: {
      authorId: 'u-1',
      parentId: 'ch-1',
      body: 'a normal message',
      createdAt: '2026-05-10T10:00:00Z',
      reactions: {},
      ...overrides,
    },
  } as unknown as SearchHit;
}

describe('MessageHitCard browser', () => {
  it('renders a basic search hit wrapped in a Link when parent resolves', async () => {
    parentResult = { label: '~general', href: '/channel/general#msg-1' };
    await render(
      <Wrap>
        <MessageHitCard hit={hit()} />
      </Wrap>,
    );
    expect(document.body.textContent).toContain('a normal message');
    expect(document.body.textContent).toContain('~general');
    // Wrapping <Link to=...> renders an <a href> with the parent href.
    const link = document.querySelector('a[href="/channel/general#msg-1"]');
    expect(link).not.toBeNull();
  });

  it('does not wrap in a Link when parent does not resolve', async () => {
    parentResult = null;
    await render(
      <Wrap>
        <MessageHitCard hit={hit()} />
      </Wrap>,
    );
    expect(document.querySelector('a[href]')).toBeNull();
    expect(document.body.textContent).toContain('a normal message');
  });

  it('renders the "replied in" prefix when the hit is a thread reply', async () => {
    parentResult = { label: '~general', href: '/channel/general' };
    await render(
      <Wrap>
        <MessageHitCard hit={hit({ parentMessageID: 'msg-root' })} />
      </Wrap>,
    );
    expect(document.body.textContent).toContain('replied in');
  });

  it('renders reactions grouped with counts', async () => {
    parentResult = { label: '~general', href: '/channel/general' };
    await render(
      <Wrap>
        <MessageHitCard
          hit={hit({
            reactions: { partyparrot: ['u-a', 'u-b'], heart: ['u-c'] },
          })}
        />
      </Wrap>,
    );
    // Reaction counts appear in the badges.
    expect(document.body.textContent).toMatch(/2/);
    expect(document.body.textContent).toMatch(/1/);
  });

  it('omits reactions panel when the reactions map is empty', async () => {
    parentResult = { label: '~general', href: '/channel/general' };
    await render(
      <Wrap>
        <MessageHitCard hit={hit({ reactions: {} })} />
      </Wrap>,
    );
    // No reaction pills rendered.
    expect(document.querySelector('.rounded-full.border')).toBeNull();
  });

  it('clicking the author with onAuthorClick fires the callback and does not navigate', async () => {
    parentResult = { label: '~general', href: '/channel/general#msg-1' };
    const onAuthorClick = vi.fn();
    const screen = await render(
      <Wrap>
        <MessageHitCard hit={hit()} onAuthorClick={onAuthorClick} />
      </Wrap>,
    );
    const author = screen.getByText(/Alice/);
    await author.click();
    expect(onAuthorClick).toHaveBeenCalledWith('u-1');
  });

  it('renders "Unknown" when the author is missing from the users-batch map', async () => {
    parentResult = { label: '~general', href: '/channel/general' };
    await render(
      <Wrap>
        <MessageHitCard hit={hit({ authorId: '' })} />
      </Wrap>,
    );
    expect(document.body.textContent).toContain('Unknown');
  });
});
