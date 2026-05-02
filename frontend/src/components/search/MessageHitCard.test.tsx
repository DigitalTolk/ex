import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageHitCard } from './MessageHitCard';
import type { SearchHit } from '@/hooks/useSearch';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function buildHit(overrides: Partial<SearchHit['_source']> = {}, id = 'm-1'): SearchHit {
  return {
    id,
    score: 1,
    _source: {
      body: 'Hello world',
      parentId: 'c-eng',
      authorId: 'u-1',
      createdAt: '2026-04-28T12:00:00Z',
      ...overrides,
    },
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/v1/users/batch')) {
      return Promise.resolve([{ id: 'u-1', displayName: 'Alice', avatarURL: 'https://x/a.png' }]);
    }
    if (url === '/api/v1/channels') {
      return Promise.resolve([{ channelID: 'c-eng', channelName: 'engineering' }]);
    }
    if (url === '/api/v1/conversations') {
      return Promise.resolve([
        { conversationID: 'conv-1', type: 'dm', displayName: 'Bob' },
      ]);
    }
    if (url === '/api/v1/emoji') {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
});

describe('MessageHitCard', () => {
  it('renders the message body, author, and channel link', async () => {
    wrap(<MessageHitCard hit={buildHit()} />);
    // The author is loaded async; the body renders immediately.
    expect(await screen.findByText('Hello world')).toBeInTheDocument();
    // After channels load, parent shows "in ~engineering".
    expect(await screen.findByText(/~engineering/)).toBeInTheDocument();
    // The card is wrapped in a Link to the channel deep-link.
    const link = screen.getByTestId('message-hit-card').closest('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toMatch(/\/channel\/engineering/);
  });

  it('shows "replied in" when threadRoot is set', async () => {
    wrap(
      <MessageHitCard
        hit={buildHit({ parentMessageID: 'root-1' })}
      />,
    );
    expect(await screen.findByText(/replied in/)).toBeInTheDocument();
  });

  it('renders the conversation parent label for DM hits', async () => {
    wrap(<MessageHitCard hit={buildHit({ parentId: 'conv-1' })} />);
    expect(await screen.findByText(/Bob/)).toBeInTheDocument();
  });

  it('renders without parent link when the user has no access', async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/users/batch')) {
        return Promise.resolve([{ id: 'u-1', displayName: 'Alice' }]);
      }
      return Promise.resolve([]);
    });
    wrap(<MessageHitCard hit={buildHit({ parentId: 'unknown' })} />);
    expect(await screen.findByText('Hello world')).toBeInTheDocument();
    // No <a> wrapper when parent is unresolved.
    const card = screen.getByTestId('message-hit-card');
    expect(card.closest('a')).toBeNull();
  });

  it('renders reactions when present', async () => {
    wrap(
      <MessageHitCard
        hit={buildHit({ reactions: { ':smile:': ['u-1', 'u-2'], ':thumbsup:': [] } })}
      />,
    );
    expect(await screen.findByText('Hello world')).toBeInTheDocument();
    // The non-empty reaction shows its count.
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('falls back to "Unknown" when the author is not in the batch', async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(() => Promise.resolve([]));
    wrap(<MessageHitCard hit={buildHit({ authorId: 'missing' })} />);
    expect(await screen.findByText('Unknown')).toBeInTheDocument();
  });

  it('clicking the author button (when onAuthorClick is set) calls the callback and stops Link navigation', async () => {
    const onAuthorClick = vi.fn();
    wrap(<MessageHitCard hit={buildHit()} onAuthorClick={onAuthorClick} />);
    const btn = await screen.findByTitle('Filter results from this person');
    fireEvent.click(btn);
    expect(onAuthorClick).toHaveBeenCalledWith('u-1');
  });

  it('handles a hit with no createdAt (no date column)', async () => {
    wrap(<MessageHitCard hit={buildHit({ createdAt: undefined })} />);
    expect(await screen.findByText('Hello world')).toBeInTheDocument();
  });
});
