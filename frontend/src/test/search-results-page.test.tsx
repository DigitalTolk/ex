import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

import SearchResultsPage from '@/pages/SearchResultsPage';

function wrap(initialEntries: string[] = ['/search?q=engineering']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <SearchResultsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  navigateMock.mockReset();
});

describe('SearchResultsPage', () => {
  it('renders an empty-state when the query param is missing', () => {
    wrap(['/search']);
    expect(screen.getByText(/type a query in the top bar/i)).toBeInTheDocument();
  });

  it('issues searches against all three indices and renders grouped hits', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/search/messages')) {
        return Promise.resolve({
          total: 1,
          hits: [
            {
              id: 'm-1',
              score: 1,
              _source: {
                body: 'Found a bug in engineering',
                parentId: 'c-1',
                authorId: 'u-1',
                createdAt: '2026-04-28T12:00:00Z',
              },
            },
          ],
        });
      }
      if (url.startsWith('/api/v1/search/channels')) {
        return Promise.resolve({
          total: 1,
          hits: [
            {
              id: 'c-1',
              score: 1,
              _source: { name: 'engineering', slug: 'engineering', description: 'eng team' },
            },
          ],
        });
      }
      if (url.startsWith('/api/v1/search/users')) {
        return Promise.resolve({
          total: 1,
          hits: [
            {
              id: 'u-1',
              score: 1,
              _source: { displayName: 'Alice', email: 'a@x.com', systemRole: 'member' },
            },
          ],
        });
      }
      // Sidebar / batch hydration calls — return empty so the page
      // doesn't blow up on missing fixtures.
      if (url.startsWith('/api/v1/channels') || url.startsWith('/api/v1/conversations')) {
        return Promise.resolve([]);
      }
      if (url.startsWith('/api/v1/users/batch') || url === '/api/v1/users') {
        return Promise.resolve([]);
      }
      if (url.startsWith('/api/v1/users/')) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    wrap(['/search?q=engineering']);

    await waitFor(() => screen.getByText(/Found a bug in/i));
    expect(screen.getByText('~engineering')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows a no-results state when every index returns 0 hits', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/search')) {
        return Promise.resolve({ total: 0, hits: [] });
      }
      return Promise.resolve([]);
    });
    wrap(['/search?q=zzz']);
    await waitFor(() => expect(screen.getByText(/no results for/i)).toBeInTheDocument());
  });

  it('lets the user filter by tab', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/search/channels')) {
        return Promise.resolve({
          total: 1,
          hits: [{ id: 'c-1', score: 1, _source: { name: 'design', slug: 'design' } }],
        });
      }
      if (url.startsWith('/api/v1/search')) {
        return Promise.resolve({ total: 0, hits: [] });
      }
      return Promise.resolve([]);
    });
    wrap(['/search?q=design']);
    await waitFor(() => screen.getByText('~design'));
    fireEvent.click(screen.getByRole('tab', { name: /people/i }));
    // People tab → channel hit must hide.
    expect(screen.queryByText('~design')).toBeNull();
  });

  it('renders file hits with their filename', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/search/files')) {
        return Promise.resolve({
          total: 1,
          hits: [
            {
              id: 'a-1',
              score: 1,
              _source: {
                filename: 'design.pdf',
                parentIds: ['c-1'],
                messageIds: ['m-7'],
                sharedBy: 'u-1',
                createdAt: '2026-04-28T12:00:00Z',
              },
            },
          ],
        });
      }
      if (url.startsWith('/api/v1/search')) {
        return Promise.resolve({ total: 0, hits: [] });
      }
      if (url === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'c-1', channelName: 'design', channelType: 'public' }]);
      }
      return Promise.resolve([]);
    });
    wrap(['/search?q=design']);
    // "design" is highlighted inside the filename, splitting it into
    // <mark>design</mark>.pdf — assert each fragment.
    await waitFor(() => expect(screen.getByText(/^design$/i)).toBeInTheDocument());
    expect(screen.getByText(/\.pdf/i)).toBeInTheDocument();
  });

  it('forwards from/in/sort to the messages endpoint', async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve({ total: 0, hits: [] }));
    wrap(['/search?q=hello&from=u-99&in=c-1&sort=newest']);
    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.map((c) => String(c[0]));
      const messagesCall = calls.find((u) => u.startsWith('/api/v1/search/messages'));
      expect(messagesCall).toBeDefined();
      expect(messagesCall).toContain('from=u-99');
      expect(messagesCall).toContain('in=c-1');
      expect(messagesCall).toContain('sort=newest');
    });
  });

  it('clicking a user hit creates a DM and navigates', async () => {
    const conversationCreate = vi.fn((_args: unknown, opts?: { onSuccess?: (c: { id: string }) => void }) => {
      opts?.onSuccess?.({ id: 'conv-7' });
    });
    apiFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url.startsWith('/api/v1/search/users')) {
        return Promise.resolve({
          total: 1,
          hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice', email: 'a@x.com', systemRole: 'member' } }],
        });
      }
      if (url.startsWith('/api/v1/search')) {
        return Promise.resolve({ total: 0, hits: [] });
      }
      if (url === '/api/v1/conversations' && init?.method === 'POST') {
        conversationCreate(init);
        return Promise.resolve({ id: 'conv-7' });
      }
      return Promise.resolve([]);
    });
    wrap(['/search?q=alice&type=people']);
    const card = await screen.findByText('Alice');
    fireEvent.click(card);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/conversation/conv-7'));
  });

  it('renders file hits even when the parent is not in the user sidebar (no link)', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/search/files')) {
        return Promise.resolve({
          total: 1,
          hits: [
            {
              id: 'a-9',
              score: 1,
              _source: {
                filename: 'notes.txt',
                parentIds: ['unknown-parent'],
                messageIds: ['m-9'],
                sharedBy: 'u-1',
              },
            },
          ],
        });
      }
      if (url.startsWith('/api/v1/search')) {
        return Promise.resolve({ total: 0, hits: [] });
      }
      return Promise.resolve([]);
    });
    wrap(['/search?q=notes&type=files']);
    await screen.findByText(/notes/i);
    const filename = screen.getByText(/notes/i);
    expect(filename.closest('a')).toBeNull();
  });

  it('DMs tab filters messages to parentType=conversation', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/search/messages')) {
        return Promise.resolve({
          total: 2,
          hits: [
            { id: 'm-channel', score: 1, _source: { body: 'in channel', parentId: 'c-1', parentType: 'channel', authorId: 'u-1' } },
            { id: 'm-dm', score: 1, _source: { body: 'in dm', parentId: 'conv-1', parentType: 'conversation', authorId: 'u-1' } },
          ],
        });
      }
      if (url.startsWith('/api/v1/search')) return Promise.resolve({ total: 0, hits: [] });
      return Promise.resolve([]);
    });
    wrap(['/search?q=hello&type=dms']);
    await waitFor(() => screen.getByText(/in dm/i));
    expect(screen.queryByText(/in channel/i)).toBeNull();
  });

  it('runs a filter-only search when q is empty but from= is set', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/users/batch')) {
        return Promise.resolve([{ id: 'u-99', displayName: 'Alice' }]);
      }
      if (url.startsWith('/api/v1/search/messages')) {
        return Promise.resolve({
          total: 1,
          hits: [
            { id: 'm-1', score: 1, _source: { body: 'all from alice', authorId: 'u-99', parentId: 'c-1' } },
          ],
          aggs: { byUser: [{ key: 'u-99', count: 1 }], byParent: [{ key: 'c-1', count: 1 }] },
        });
      }
      if (url.startsWith('/api/v1/search')) return Promise.resolve({ total: 0, hits: [] });
      if (url === '/api/v1/channels') return Promise.resolve([]);
      if (url === '/api/v1/conversations') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    wrap(['/search?from=u-99']);
    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.startsWith('/api/v1/search/messages') && u.includes('from=u-99'))).toBe(true);
    });
  });

  it('renders bucket-driven From + In dropdowns using aggregations', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/search/messages')) {
        return Promise.resolve({
          total: 1,
          hits: [],
          aggs: {
            byUser: [{ key: 'u-1', count: 7 }],
            byParent: [{ key: 'c-1', count: 4 }],
          },
        });
      }
      if (url.startsWith('/api/v1/users/batch')) {
        return Promise.resolve([{ id: 'u-1', displayName: 'Alice' }]);
      }
      if (url === '/api/v1/channels') {
        return Promise.resolve([
          { channelID: 'c-1', channelName: 'engineering', channelType: 'public' },
        ]);
      }
      if (url.startsWith('/api/v1/search')) return Promise.resolve({ total: 0, hits: [] });
      return Promise.resolve([]);
    });
    wrap(['/search?q=hello&type=messages']);
    await waitFor(() => screen.getByTestId('bucket-picker-users'));
    fireEvent.click(screen.getByTestId('bucket-picker-users'));
    await waitFor(() => screen.getByText('Alice'));
    expect(screen.getByText('7')).toBeInTheDocument();
    // Selecting a bucket sets ?from= via updateParams.
    fireEvent.click(screen.getByText('Alice'));
    await waitFor(() => screen.getByText(/From: Alice/i));

    fireEvent.click(screen.getByTestId('bucket-picker-channels'));
    await waitFor(() => screen.getByText('~engineering'));
    expect(screen.getByText('4')).toBeInTheDocument();
    fireEvent.click(screen.getByText('~engineering'));
    await waitFor(() => screen.getByText(/In: ~engineering/i));
  });

  it('clears the From filter when its chip X is clicked', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/users/batch')) {
        return Promise.resolve([{ id: 'u-99', displayName: 'Alice' }]);
      }
      if (url.startsWith('/api/v1/search')) {
        return Promise.resolve({ total: 0, hits: [] });
      }
      return Promise.resolve([]);
    });
    wrap(['/search?q=x&from=u-99']);
    await screen.findByText(/From: Alice/i);
    fireEvent.click(screen.getByLabelText(/Clear From: Alice/i));
    await waitFor(() => expect(screen.queryByText(/From: Alice/i)).toBeNull());
  });
});
