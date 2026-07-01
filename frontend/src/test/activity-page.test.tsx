import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ActivityPage from '@/pages/ActivityPage';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@/hooks/useEmoji', () => ({ useEmojiMap: () => ({ data: {} }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-me' } }) }));
vi.mock('@/components/UserHoverCard', () => ({
  UserHoverCard: ({ children }: { children: React.ReactNode }) => <span data-testid="hovercard">{children}</span>,
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ActivityPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const reactionItem = {
  id: 'a1',
  type: 'reaction',
  createdAt: '2026-06-30T10:00:00Z',
  messageID: 'm1',
  parentID: 'ch-1',
  parentType: 'channel',
  messagePreview: 'the deploy is green',
  actorID: 'u-2',
  emoji: '🎉',
};
const reminderItem = {
  id: 'a2',
  type: 'reminder',
  createdAt: '2026-06-30T11:00:00Z',
  messageID: 'm2',
  parentID: 'conv-9',
  parentType: 'conversation',
  messagePreview: 'follow up here',
};

function mockApi(over: { feed?: unknown; reminders?: unknown } = {}) {
  vi.mocked(apiFetch).mockImplementation(async (path, options) => {
    if (path === '/api/v1/activity') return over.feed ?? { items: [reactionItem, reminderItem], unread: 1 };
    if (path === '/api/v1/reminders') return over.reminders ?? [];
    if (path === '/api/v1/channels') return [{ channelID: 'ch-1', channelName: 'General', channelType: 'public', role: 1 }];
    if (path === '/api/v1/users/batch') return [{ id: 'u-2', displayName: 'Bob' }];
    if (path === '/api/v1/activity/read' && options?.method === 'PUT') return undefined;
    if (options?.method === 'DELETE') return undefined;
    return undefined;
  });
}

describe('ActivityPage', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('renders reaction + reminder items and marks activity read on mount', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('reacted to your message')).toBeInTheDocument();
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    // Emoji renders via EmojiGlyph (unicode glyph), not the raw shortcode.
    expect(screen.getByText('🎉')).toBeInTheDocument();
    // Reaction's preview links to the channel message by slug; the reminder row
    // is itself the link to the conversation message.
    expect(screen.getByTestId('activity-link')).toHaveAttribute('href', '/channel/general#msg-m1');
    const reminderRow = screen.getAllByTestId('activity-item').find((el) => el.tagName === 'A');
    expect(reminderRow).toHaveAttribute('href', '/conversation/conv-9#msg-m2');
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/v1/activity/read', { method: 'PUT' }),
    );
  });

  it('shows the empty state when there is no activity', async () => {
    mockApi({ feed: { items: [], unread: 0 } });
    renderPage();
    expect(await screen.findByTestId('activity-empty')).toBeInTheDocument();
  });

  it('falls back to channel id, plain labels, and "Someone" when data is missing', async () => {
    // Reaction with no slug and a channel NOT in the cache → parentID-based href;
    // unknown actor → "Someone"; reminder with no preview → no preview line.
    mockApi({
      feed: {
        items: [
          { id: 'a1', type: 'reaction', createdAt: '2026-06-30T10:00:00Z', messageID: 'm1', parentID: 'ch-unknown', parentType: 'channel' },
          { id: 'a2', type: 'reminder', createdAt: '2026-06-30T11:00:00Z', messageID: 'm2', parentID: 'ch-1', parentType: 'channel' },
        ],
        unread: 0,
      },
    });
    renderPage();
    expect(await screen.findByText('Someone')).toBeInTheDocument();
    expect(screen.getByTestId('activity-link')).toHaveAttribute('href', '/channel/ch-unknown#msg-m1');
    expect(screen.getByText('Reminder')).toBeInTheDocument();
  });

  it('shows a placeholder for a pending reminder with no preview', async () => {
    mockApi({
      feed: { items: [], unread: 0 },
      reminders: [
        { id: 'r1', userID: 'u-1', messageID: 'm3', parentID: 'ch-1', parentType: 'channel', remindAt: '2026-07-01T09:00:00Z', createdAt: '2026-06-30T09:00:00Z' },
      ],
    });
    renderPage();
    expect(await screen.findByText('A message')).toBeInTheDocument();
  });

  it('lists pending reminders and cancels one', async () => {
    mockApi({
      reminders: [
        { id: 'r1', userID: 'u-1', messageID: 'm3', parentID: 'ch-1', parentType: 'channel', channelSlug: 'general', messagePreview: 'ping me', remindAt: '2026-07-01T09:00:00Z', createdAt: '2026-06-30T09:00:00Z' },
      ],
    });
    renderPage();
    expect(await screen.findByTestId('pending-reminder')).toBeInTheDocument();
    expect(screen.getByText('ping me')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cancel-reminder'));
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/v1/reminders/r1', { method: 'DELETE' }),
    );
  });
});
