import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationView } from './ConversationView';
import type { Conversation } from '@/types';
import { queryKeys } from '@/lib/query-keys';

// --- mocks ---------------------------------------------------------------


let conversationQuery: { data?: Conversation; error?: Error; isLoading?: boolean };

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', displayName: 'Alice', email: 'a@a.com', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    setAuth: vi.fn(),
  }),
}));

// ONE stable object (see channel-view-actions.test): the mount effect lists
// setActiveConversation/setActiveParent in its deps, so per-render vi.fn()
// identities would re-run it — re-PUTting /read on every re-render.
const unreadValue = {
  unreadChannels: new Set(),
  unreadChannelNotifications: new Set(),
  unreadConversations: new Set(),
  markChannelUnread: vi.fn(),
  markChannelNotificationUnread: vi.fn(),
  markConversationUnread: vi.fn(),
  clearChannelUnread: vi.fn(),
  clearConversationUnread: vi.fn(),
  setActiveChannel: vi.fn(),
  setActiveConversation: vi.fn(),
  isActiveChannel: vi.fn(() => false),
  isActiveConversation: vi.fn(() => false),
  setActiveThread: vi.fn(),
  isActiveThread: vi.fn(() => false),
};
vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => unreadValue,
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set<string>(),
    isOnline: () => false,
    setUserOnline: vi.fn(),
  }),
  PresenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useConversations', async (orig) => ({
  // The real useUserConversations, reading the cache the test fills.
  useUserConversations: (await orig<typeof import('@/hooks/useConversations')>()).useUserConversations,
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useConversation: () => conversationQuery,
  useSearchUsers: () => ({ data: [] }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Counts renders of the chat's header, memoized like the real one.
const headerRenders = vi.hoisted(() => ({ count: 0, title: '' }));
vi.mock('@/components/layout/Header', async () => {
  const { memo } = await import('react');
  return {
    Header: memo(function Header({ title }: { title?: string }) {
      headerRenders.count++;
      return <div data-testid="header-stub">{title}</div>;
    }),
  };
});

vi.mock('@/hooks/useMessages', () => ({
  useConversationMessages: () => ({
    data: { pages: [{ items: [] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    fetchNextPage: vi.fn(),
  }),
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

const server = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    apiFetch: vi.fn(async (url: string) => (url === '/api/v1/conversations' ? server.rows : undefined)),
  };
});

vi.mock('./MessageInput', async () => {
  const React = await import('react');
  type Handle = { uploadFiles: (files: File[]) => Promise<void> };
  const MessageInput = React.forwardRef<Handle, { placeholder?: string }>(({ placeholder }, ref) => {
    React.useImperativeHandle(ref, () => ({
      uploadFiles: () => Promise.resolve(),
    }));
    return (
      <div>
        <textarea aria-label="Message input" placeholder={placeholder} />
        {placeholder ? <span>{placeholder}</span> : null}
      </div>
    );
  });
  MessageInput.displayName = 'MessageInputStub';
  return { MessageInput };
});

// --- tests ---------------------------------------------------------------

const rows = [
  { conversationID: 'conv-1', type: 'dm', displayName: 'Bob', participantIDs: ['u-1', 'u-2'] },
  { conversationID: 'conv-2', type: 'dm', displayName: 'Carol', participantIDs: ['u-1', 'u-3'] },
];

describe('ConversationView subscription breadth', () => {
  // React Query delivers cache changes to observers on a later tick.
  const update = async (qc: QueryClient, fn: (prev: typeof rows) => typeof rows) => {
    await act(async () => {
      qc.setQueryData(queryKeys.userConversations(), fn);
      server.rows = qc.getQueryData(queryKeys.userConversations()) as unknown[];
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it('ignores sidebar changes to other chats, and still shows its own name while loading', async () => {
    conversationQuery = { isLoading: true };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(queryKeys.userConversations(), rows);
    server.rows = rows;
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/conversation/conv-1']}>
          <Routes>
            <Route path="/conversation/:id" element={<ConversationView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('header-stub')).toHaveTextContent('Bob');
    await update(qc, (prev) => prev);
    const before = headerRenders.count;

    // A message lands in the chat with Carol: only her row changes.
    await update(qc, (prev) => prev.map((r) => (r.conversationID === 'conv-2' ? { ...r, unread: true, unreadCount: 2 } : r)));
    expect(headerRenders.count).toBe(before);

    // This chat is renamed: the header follows.
    await update(qc, (prev) => prev.map((r) => (r.conversationID === 'conv-1' ? { ...r, displayName: 'Bobby' } : r)));
    expect(screen.getByTestId('header-stub')).toHaveTextContent('Bobby');
  });
});
