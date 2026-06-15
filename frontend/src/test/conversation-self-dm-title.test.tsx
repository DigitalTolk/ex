import { describe, it, expect, vi } from 'vitest';

// MarkdownComposer pulls in roster/channel/emoji/auth/presence data hooks these
// view-level tests don't stub; they don't exercise the composer, so stub it with
// a plain textarea (matches the message-input-validation stub).
vi.mock('@/components/chat/markdown/MarkdownComposer', () => ({
  MarkdownComposer: (props: {
    ariaLabel?: string;
    placeholder?: string;
    onChange?: (md: string) => void;
    onSubmit?: (md: string) => void;
  }) => (
    <div>
      <textarea
        aria-label={props.ariaLabel ?? 'Message input'}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            props.onSubmit?.((e.target as HTMLTextAreaElement).value);
          }
        }}
        data-testid="composer-stub"
      />
      {props.placeholder ? <span>{props.placeholder}</span> : null}
    </div>
  ),
}));
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationView } from '@/components/chat/ConversationView';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-me', email: 'me@x.com', displayName: 'Günter Self', avatarURL: 'http://x/me.png' },
    isAuthenticated: true,
  }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    clearConversationUnread: vi.fn(),
    setActiveConversation: vi.fn(),
  }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>(), isOnline: () => false, setUserOnline: vi.fn() }),
}));

vi.mock('@/context/NotificationContext', () => ({
  useNotifications: () => ({ setActiveParent: vi.fn(), dispatch: vi.fn() }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useConversation: () => ({
    data: {
      id: 'c-self',
      type: 'dm',
      participantIDs: ['u-me'],
      name: '',
      createdAt: '',
    },
  }),
}));

vi.mock('@/hooks/useMessages', () => ({
  useConversationMessages: () => ({
    data: { pages: [{ items: [] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    fetchNextPage: vi.fn(),
  }),
  useSendConversationMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));

describe('ConversationView — self-DM header', () => {
  it("shows the current user's name and avatar instead of 'Direct Message'", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/conversation/c-self`]}>
          <Routes>
            <Route path="/conversation/:id" element={<ConversationView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.queryByText('Direct Message')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Günter Self' })).toBeInTheDocument();
  });
});
