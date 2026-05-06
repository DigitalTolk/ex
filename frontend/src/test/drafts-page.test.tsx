import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DraftsPage from '@/pages/DraftsPage';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/hooks/useDocumentTitle', () => ({
  useDocumentTitle: vi.fn(),
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DraftsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DraftsPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('renders one-line draft links and deletes a draft after confirmation', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      if (path === '/api/v1/drafts' && !options?.method) {
        return [
          {
            id: 'draft-1',
            userID: 'u-1',
            parentID: 'ch-1',
            parentType: 'channel',
            parentMessageID: 'root-1',
            body: 'finish\nthis thought',
            updatedAt: '2026-05-03T12:00:00Z',
            createdAt: '2026-05-03T11:00:00Z',
          },
        ];
      }
      if (path === '/api/v1/channels') {
        return [{ channelID: 'ch-1', channelName: 'Team Room', channelType: 'public', role: 1 }];
      }
      if (path === '/api/v1/conversations') return [];
      return undefined;
    });

    renderPage();

    const row = await screen.findByTestId('draft-row');
    expect(screen.getByTestId('draft-parent-public-channel-icon')).toBeInTheDocument();
    expect(row).toHaveTextContent('~Team Room');
    expect(row).toHaveTextContent('thread');
    expect(row).toHaveTextContent('finish this thought');
    expect(row).toHaveTextContent('Updated May 3rd at');
    expect(screen.getByRole('link', { name: /team room/i })).toHaveAttribute(
      'href',
      '/channel/team-room?thread=root-1#msg-root-1',
    );
    expect(screen.getByLabelText('Delete draft')).toHaveClass('h-8', 'w-8', 'max-md:h-9', 'max-md:w-9');

    fireEvent.click(screen.getByLabelText('Delete draft'));
    expect(await screen.findByTestId('delete-draft-dialog')).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith('/api/v1/drafts/draft-1', { method: 'DELETE' });
    fireEvent.click(screen.getByTestId('delete-draft-dialog-confirm'));
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts/draft-1', { method: 'DELETE' });
    });
  });

  it('renders mention markdown in draft previews as readable labels', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === '/api/v1/drafts') {
        return [
          {
            id: 'draft-mentions',
            userID: 'u-1',
            parentID: 'ch-1',
            parentType: 'channel',
            body: 'ping @[u-2|Ada Lovelace] in ~[ch-2|engineering]',
            updatedAt: '2026-05-03T12:00:00Z',
            createdAt: '2026-05-03T11:00:00Z',
          },
        ];
      }
      if (path === '/api/v1/channels') {
        return [{ channelID: 'ch-1', channelName: 'Team Room', channelType: 'public', role: 1 }];
      }
      if (path === '/api/v1/conversations') return [];
      return undefined;
    });

    renderPage();

    const row = await screen.findByTestId('draft-row');
    expect(row).toHaveTextContent('ping @Ada Lovelace in ~engineering');
    expect(row).not.toHaveTextContent('@[u-2|Ada Lovelace]');
    expect(row).not.toHaveTextContent('~[ch-2|engineering]');
  });

  it('shows the empty state', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === '/api/v1/drafts') return [];
      if (path === '/api/v1/channels') return [];
      if (path === '/api/v1/conversations') return [];
      return undefined;
    });

    renderPage();

    expect(await screen.findByTestId('drafts-empty')).toHaveTextContent('No drafts.');
  });

  it('renders loading, conversation drafts, and fallback draft labels', async () => {
    let resolveDrafts: (value: unknown) => void = () => {};
    const draftsPromise = new Promise((resolve) => {
      resolveDrafts = resolve;
    });
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === '/api/v1/drafts') return draftsPromise;
      if (path === '/api/v1/channels') return [];
      if (path === '/api/v1/conversations') {
        return [{ conversationID: 'dm-1', type: 'dm', displayName: 'Ada Lovelace' }];
      }
      return undefined;
    });

    renderPage();
    expect(screen.getByTestId('drafts-loading')).toBeInTheDocument();

    resolveDrafts([
      {
        id: 'draft-2',
        userID: 'u-1',
        parentID: 'dm-1',
        parentType: 'conversation',
        body: 'hello ada',
        updatedAt: '2026-05-03T12:00:00Z',
        createdAt: '2026-05-03T11:00:00Z',
      },
      {
        id: 'draft-3',
        userID: 'u-1',
        parentID: 'ch-missing',
        parentType: 'channel',
        body: '',
        updatedAt: '2026-05-03T12:05:00Z',
        createdAt: '2026-05-03T11:05:00Z',
      },
    ]);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByTestId('draft-parent-dm-icon')).toBeInTheDocument();
    expect(screen.getByTestId('draft-parent-public-channel-icon')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ada lovelace/i })).toHaveAttribute(
      'href',
      '/conversation/dm-1',
    );
    expect(screen.getByText('~channel')).toBeInTheDocument();
    expect(screen.getByText('Attachment draft')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /attachment draft/i })).toHaveAttribute(
      'href',
      '/channel/ch-missing',
    );
  });

  it('shows private channel and group conversation icons', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === '/api/v1/drafts') {
        return [
          {
            id: 'draft-private',
            userID: 'u-1',
            parentID: 'ch-private',
            parentType: 'channel',
            body: 'private note',
            updatedAt: '2026-05-03T12:00:00Z',
            createdAt: '2026-05-03T11:00:00Z',
          },
          {
            id: 'draft-group',
            userID: 'u-1',
            parentID: 'group-1',
            parentType: 'conversation',
            body: 'group note',
            updatedAt: '2026-05-03T12:05:00Z',
            createdAt: '2026-05-03T11:05:00Z',
          },
        ];
      }
      if (path === '/api/v1/channels') {
        return [
          {
            channelID: 'ch-private',
            channelName: 'secret',
            channelType: 'private',
            role: 1,
          },
        ];
      }
      if (path === '/api/v1/conversations') {
        return [
          {
            conversationID: 'group-1',
            type: 'group',
            displayName: 'Project Group',
          },
        ];
      }
      return undefined;
    });

    renderPage();

    expect(await screen.findByText('~secret')).toBeInTheDocument();
    expect(screen.getByText('Project Group')).toBeInTheDocument();
    expect(screen.getByTestId('draft-parent-private-channel-icon')).toBeInTheDocument();
    expect(screen.getByTestId('draft-parent-group-icon')).toBeInTheDocument();
  });

  it('uses the conversation fallback label and cancels draft deletion without mutating', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      if (path === '/api/v1/drafts' && !options?.method) {
        return [
          {
            id: 'draft-4',
            userID: 'u-1',
            parentID: 'dm-missing',
            parentType: 'conversation',
            body: 'unknown conversation',
            updatedAt: '2026-05-03T12:10:00Z',
            createdAt: '2026-05-03T11:10:00Z',
          },
        ];
      }
      if (path === '/api/v1/channels') return [];
      if (path === '/api/v1/conversations') return [];
      return undefined;
    });

    renderPage();

    expect(await screen.findByText('Conversation')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Delete draft'));
    expect(await screen.findByTestId('delete-draft-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('delete-draft-dialog-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('delete-draft-dialog')).not.toBeInTheDocument();
    });
    expect(apiFetch).not.toHaveBeenCalledWith('/api/v1/drafts/draft-4', { method: 'DELETE' });
  });
});
