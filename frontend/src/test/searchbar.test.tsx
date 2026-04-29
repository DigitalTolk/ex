import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

import { SearchBar } from '@/components/SearchBar';

function wrap(initialPath = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SearchBar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  navigateMock.mockReset();
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue(null);
});

describe('SearchBar', () => {
  it('renders the search input', () => {
    wrap();
    expect(screen.getByTestId('searchbar-input')).toBeInTheDocument();
  });

  it('opens a "Show results for" dropdown once the user types', () => {
    wrap();
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'claude' } });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();
    expect(screen.getByTestId('searchbar-show-results')).toHaveTextContent(/Show results for/i);
    expect(screen.getByTestId('searchbar-show-results')).toHaveTextContent('claude');
  });

  it('navigates to /search?q=... when the suggestion is clicked', () => {
    wrap();
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'engineering' } });
    fireEvent.click(screen.getByTestId('searchbar-show-results'));
    expect(navigateMock).toHaveBeenCalledWith('/search?q=engineering');
  });

  it('navigates on Enter', () => {
    wrap();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'design' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigateMock).toHaveBeenCalledWith('/search?q=design');
  });

  it('does not show the dropdown when the field is empty', () => {
    wrap();
    fireEvent.focus(screen.getByTestId('searchbar-input'));
    expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
  });

  it('closes on Escape', () => {
    wrap();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'x' } });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
  });

  it('shows the in-channel suggestion when on a channel route', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/channels/engineering') {
        return Promise.resolve({ id: 'c-eng', slug: 'engineering', name: 'engineering', type: 'public' });
      }
      return Promise.resolve(null);
    });
    wrap('/channel/engineering');
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'bug' } });
    // Wait for the channel-by-slug fetch to settle.
    await screen.findByTestId('searchbar-show-in-scope');
    expect(screen.getByTestId('searchbar-show-results')).toBeInTheDocument();
    expect(screen.getByTestId('searchbar-show-in-scope')).toHaveTextContent(/in this channel/i);
    expect(screen.getByTestId('searchbar-show-in-scope')).toHaveTextContent('~engineering');
  });

  it('passes ?in=<channelId>&type=messages when the in-channel suggestion is picked', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/channels/engineering') {
        return Promise.resolve({ id: 'c-eng', slug: 'engineering', name: 'engineering', type: 'public' });
      }
      return Promise.resolve(null);
    });
    wrap('/channel/engineering');
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'bug' } });
    fireEvent.click(await screen.findByTestId('searchbar-show-in-scope'));
    expect(navigateMock).toHaveBeenCalledWith('/search?q=bug&in=c-eng&type=messages');
  });

  it('arrow keys cycle the suggestions and Enter submits the highlighted one', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/channels/design') {
        return Promise.resolve({ id: 'c-d', slug: 'design', name: 'design', type: 'public' });
      }
      return Promise.resolve(null);
    });
    wrap('/channel/design');
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'logo' } });
    await screen.findByTestId('searchbar-show-in-scope');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigateMock).toHaveBeenCalledWith('/search?q=logo&in=c-d&type=messages');
  });

  it('shows an in-DM suggestion on a DM conversation route', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/conversations') {
        return Promise.resolve([
          { conversationID: 'conv-dm', type: 'dm', displayName: 'Alice' },
        ]);
      }
      return Promise.resolve(null);
    });
    wrap('/conversation/conv-dm');
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'lunch' } });
    const inScope = await screen.findByTestId('searchbar-show-in-scope');
    expect(inScope).toHaveTextContent(/in this dm/i);
    expect(inScope).toHaveTextContent('Alice');
    expect(inScope).toHaveAttribute('data-scope-kind', 'dm');
    fireEvent.click(inScope);
    expect(navigateMock).toHaveBeenCalledWith('/search?q=lunch&in=conv-dm&type=dms');
  });

  it('shows an in-group suggestion on a group conversation route', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/conversations') {
        return Promise.resolve([
          { conversationID: 'conv-grp', type: 'group', displayName: 'Alice, Bob' },
        ]);
      }
      return Promise.resolve(null);
    });
    wrap('/conversation/conv-grp');
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'plan' } });
    const inScope = await screen.findByTestId('searchbar-show-in-scope');
    expect(inScope).toHaveTextContent(/in this group/i);
    expect(inScope).toHaveTextContent('Alice, Bob');
    expect(inScope).toHaveAttribute('data-scope-kind', 'group');
    fireEvent.click(inScope);
    expect(navigateMock).toHaveBeenCalledWith('/search?q=plan&in=conv-grp&type=dms');
  });
});
