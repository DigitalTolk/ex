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
    expect(row).toHaveTextContent('~Team Room');
    expect(row).toHaveTextContent('thread');
    expect(row).toHaveTextContent('finish this thought');
    expect(row).toHaveTextContent('Updated May 3rd at');
    expect(screen.getByRole('link', { name: /team room/i })).toHaveAttribute(
      'href',
      '/channel/team-room?thread=root-1#msg-root-1',
    );

    fireEvent.click(screen.getByLabelText('Delete draft'));
    expect(await screen.findByTestId('delete-draft-dialog')).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith('/api/v1/drafts/draft-1', { method: 'DELETE' });
    fireEvent.click(screen.getByTestId('delete-draft-dialog-confirm'));
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts/draft-1', { method: 'DELETE' });
    });
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
        return [{ conversationID: 'dm-1', displayName: 'Ada Lovelace' }];
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
