import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { FilesPanel } from '@/components/chat/FilesPanel';

function renderPanel(
  props: { channelId?: string; conversationId?: string } = { channelId: 'ch-1' },
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FilesPanel
        channelId={props.channelId}
        conversationId={props.conversationId}
        onClose={vi.fn()}
        userMap={{
          'u-1': { displayName: 'Alice' },
        }}
      />
    </QueryClientProvider>,
  );
}

describe('FilesPanel', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('renders an empty state when no files have been shared', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/files')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('files-empty')).toBeInTheDocument());
  });

  it('renders one row per file with author + filename', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/files')) {
        return Promise.resolve([
          { attachmentID: 'a-1', messageID: 'm-1', authorID: 'u-1', createdAt: '2026-04-26T10:00:00Z' },
        ]);
      }
      if (path.includes('/attachments?ids=')) {
        return Promise.resolve([
          {
            id: 'a-1',
            sha256: 'h',
            size: 1024,
            contentType: 'image/png',
            filename: 'shot.png',
            url: 'https://x/shot.png',
            createdBy: 'u-1',
            createdAt: '2026-04-26T10:00:00Z',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument());
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
  });

  it('hits the right path for conversations', async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve([]));
    renderPanel({ channelId: undefined, conversationId: 'conv-9' });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/conversations/conv-9/files');
  });
});
