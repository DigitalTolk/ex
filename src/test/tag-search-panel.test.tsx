import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { TagSearchProvider } from '@/context/TagSearchContext';
import { TagSearchPanel } from '@/components/TagSearchPanel';

// Each MessageHitCard fans out to /api/v1/users/batch +
// /api/v1/channels + /api/v1/conversations to resolve author and
// parent labels. Route those to canned data so the search call we
// actually want to assert on is easy to find.
function mockSupportingFetches() {
  apiFetchMock.mockImplementation((url: string) => {
    if (url === '/api/v1/channels') {
      return Promise.resolve([{ channelID: 'c-7', channelName: 'engineering', channelType: 'public' }]);
    }
    if (url === '/api/v1/conversations') {
      return Promise.resolve([]);
    }
    if (url.startsWith('/api/v1/users/batch')) {
      return Promise.resolve([{ id: 'u-1', displayName: 'Alice' }]);
    }
    return Promise.resolve({ total: 0, hits: [] });
  });
}

function wrap(tag: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <TagSearchProvider initialTag={tag}>
          <TagSearchPanel />
        </TagSearchProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('TagSearchPanel', () => {
  it('does not render when no tag is active', () => {
    mockSupportingFetches();
    wrap(null);
    expect(screen.queryByTestId('tag-search-panel')).toBeNull();
  });

  it('queries /search/messages with #<tag> and lists hits', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/search/messages')) {
        return Promise.resolve({
          total: 1,
          hits: [{ id: 'm-1', score: 1, _source: { body: 'Found a #BugFix', parentId: 'c-7', authorId: 'u-1' } }],
        });
      }
      if (url === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'c-7', channelName: 'engineering', channelType: 'public' }]);
      }
      if (url === '/api/v1/conversations') return Promise.resolve([]);
      if (url.startsWith('/api/v1/users/batch')) return Promise.resolve([{ id: 'u-1', displayName: 'Alice' }]);
      return Promise.resolve({ total: 0, hits: [] });
    });
    wrap('bugfix');

    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('/search/messages?q='))).toBe(true);
      expect(calls.some((u) => u.includes(encodeURIComponent('#bugfix')))).toBe(true);
    });

    expect(await screen.findByTestId('tag-search-panel')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Found a/)).toBeInTheDocument();
    });
  });

  it('renders each hit as a Link pointing at the message deep-link', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/search/messages')) {
        return Promise.resolve({
          total: 1,
          hits: [{ id: 'm-9', score: 1, _source: { body: 'click me', parentId: 'c-7', authorId: 'u-1' } }],
        });
      }
      if (url === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'c-7', channelName: 'engineering', channelType: 'public' }]);
      }
      if (url === '/api/v1/conversations') return Promise.resolve([]);
      if (url.startsWith('/api/v1/users/batch')) return Promise.resolve([{ id: 'u-1', displayName: 'Alice' }]);
      return Promise.resolve({ total: 0, hits: [] });
    });
    wrap('foo');
    // Wait for the channel context label — once that's resolved the
    // body wraps in a <Link>.
    await screen.findByText(/~engineering/i);
    await waitFor(() => {
      const anchor = screen.getByText('click me').closest('a');
      expect(anchor?.getAttribute('href')).toBe('/channel/engineering#msg-m-9');
    });
  });

  it('shows an empty-state when search returns no hits', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/channels') return Promise.resolve([]);
      if (url === '/api/v1/conversations') return Promise.resolve([]);
      return Promise.resolve({ total: 0, hits: [] });
    });
    wrap('zzz');
    await waitFor(() =>
      expect(screen.getByText(/no messages tagged/i)).toBeInTheDocument(),
    );
  });

  it('surfaces a search-error message in the panel', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/search/messages')) {
        return Promise.reject(new Error('opensearch went away'));
      }
      if (url === '/api/v1/channels') return Promise.resolve([]);
      if (url === '/api/v1/conversations') return Promise.resolve([]);
      return Promise.resolve({ total: 0, hits: [] });
    });
    wrap('boom');
    await waitFor(() =>
      expect(screen.getByText(/opensearch went away/i)).toBeInTheDocument(),
    );
  });
});
