import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useEmoji', () => ({ useEmojis: () => ({ data: [] }), useEmojiMap: () => ({ data: {} }) }));
vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));
vi.mock('@/components/ui/dropdown-menu');

import { MessageItem } from '@/components/chat/MessageItem';
import type { Message } from '@/types';

function renderMessage(body: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const message: Message = { id: 'msg-1', parentID: 'channel-1', authorID: 'user-2', body, createdAt: '2026-11-05T10:30:00Z' };
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MessageItem message={message} authorName="Alice" currentUserId="user-1" isOwn={false} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string) => {
    if (path === '/api/v1/users/user-1/usergroups') return Promise.resolve([{ id: 'group-oncall', handle: 'oncall' }]);
    if (path === '/api/v1/usergroups/group-oncall') {
      return Promise.resolve({ id: 'group-oncall', handle: 'oncall', name: 'On-call', description: '', disabled: false, memberIds: ['user-1'] });
    }
    return Promise.resolve([]);
  });
});

describe('MessageItem — user-group mentions', () => {
  it("highlights a group the viewer belongs to and opens the group's card", async () => {
    renderMessage('db down @[group-oncall|oncall] and @[group-sre|sre]');
    const [mine, other] = screen.getAllByTestId('usergroup-mention-pill');
    await waitFor(() => expect(mine).toHaveAttribute('data-mention-self', 'true'));
    expect(other).toHaveAttribute('data-mention-self', 'false');
    fireEvent.click(mine);
    expect(await screen.findByTestId('usergroup-card')).toHaveTextContent('On-call');
  });

  it("doesn't look up the viewer's groups for a message that mentions none", () => {
    renderMessage('just text');
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/users/user-1/usergroups');
  });
});
