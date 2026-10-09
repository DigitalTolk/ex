import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ActivityPage from '@/pages/ActivityPage';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@/hooks/useEmoji', () => ({ useEmojiMap: () => ({ data: {} }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-me' } }) }));
vi.mock('@/components/UserHoverCard', () => ({
  UserHoverCard: ({ children }: { children: ReactNode }) => <span data-testid="hovercard">{children}</span>,
}));
vi.mock('@/components/ui/dropdown-menu');
// jsdom has no layout, so the real list would render no rows; render them all.
// The real virtualized list is covered by ActivityPage.browser.test.tsx.
vi.mock('react-virtuoso', () => ({
  Virtuoso: <T,>({ data, itemContent, computeItemKey }: {
    data: T[];
    itemContent: (index: number, row: T) => ReactNode;
    computeItemKey: (index: number, row: T) => string;
  }) => (
    <div data-testid="virtuoso">
      {data.map((row, i) => (
        <div key={computeItemKey(i, row)}>{itemContent(i, row)}</div>
      ))}
    </div>
  ),
}));

function renderPage(path = '/activity') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
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
  read: false,
};
const reminderItem = {
  id: 'a2',
  type: 'reminder',
  createdAt: '2026-06-30T11:00:00Z',
  messageID: 'm2',
  parentID: 'conv-9',
  parentType: 'conversation',
  messagePreview: 'follow up here',
  read: true,
};

function mockApi(over: { feed?: unknown; reminders?: unknown } = {}) {
  let allRead = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    // Mark all read sticks on the next read, like the server's watermark.
    if (path === '/api/v1/activity/read') allRead = true;
    if (path === '/api/v1/activity' && allRead) return { items: [{ ...reactionItem, read: true }, reminderItem], unread: 0, unreadByType: {} };
    if (path === '/api/v1/activity') return over.feed ?? { items: [reactionItem, reminderItem], unread: 1, unreadByType: { reaction: 1 } };
    if (path === '/api/v1/reminders') return over.reminders ?? [];
    if (path === '/api/v1/channels') return [{ channelID: 'ch-1', channelName: 'General', channelType: 'public', role: 1 }];
    if (path === '/api/v1/users/batch') return [{ id: 'u-2', displayName: 'Bob' }];
    return undefined;
  });
}

function calls(path: string) {
  return vi.mocked(apiFetch).mock.calls.filter(([p]) => p === path);
}

function rowFor(text: string) {
  return screen.getByText(text).closest('[data-testid="activity-item"]') as HTMLElement;
}

describe('ActivityPage', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  // Opening the page used to mark everything read, wiping every per-item
  // "Mark as unread" — reading is now explicit.
  it('renders the rows and leaves their read state alone on open', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('reacted to your message')).toBeInTheDocument();
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    // Emoji renders via EmojiGlyph (unicode glyph), not the raw shortcode.
    expect(screen.getByText('🎉')).toBeInTheDocument();
    const [reaction, reminder] = screen.getAllByTestId('activity-link');
    expect(reaction).toHaveAttribute('href', '/channel/general#msg-m1');
    expect(reminder).toHaveAttribute('href', '/conversation/conv-9#msg-m2');
    expect(screen.getByText('Reminder')).toBeInTheDocument();
    // The unread reaction is marked; the read reminder isn't.
    expect(rowFor('the deploy is green')).toHaveAttribute('data-unread', 'true');
    expect(rowFor('follow up here')).not.toHaveAttribute('data-unread');
    expect(within(rowFor('the deploy is green')).getByTestId('activity-unread-dot')).toBeInTheDocument();
    await waitFor(() => expect(calls('/api/v1/users/batch')).toHaveLength(1));
    expect(calls('/api/v1/activity/read')).toHaveLength(0);
    // Labels only: no description under the heading.
    expect(screen.queryByText(/Mentions, replies, messages/)).not.toBeInTheDocument();
  });

  it('marks everything read from the header button', async () => {
    mockApi();
    renderPage();
    const button = await screen.findByTestId('activity-mark-all-read');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(calls('/api/v1/activity/read')).toEqual([['/api/v1/activity/read', { method: 'PUT' }]]));
    await waitFor(() => expect(rowFor('the deploy is green')).not.toHaveAttribute('data-unread'));
  });

  it('disables mark-all when nothing is unread', async () => {
    mockApi({ feed: { items: [reminderItem], unread: 0, unreadByType: {} } });
    renderPage();
    await screen.findByText('Reminder');
    expect(screen.getByTestId('activity-mark-all-read')).toBeDisabled();
  });

  it('shows the empty state when there is no activity', async () => {
    mockApi({ feed: { items: [], unread: 0 } });
    renderPage();
    expect(await screen.findByTestId('activity-empty')).toBeInTheDocument();
  });

  it('falls back to channel id, plain labels, and "Someone" when data is missing', async () => {
    mockApi({
      feed: {
        items: [
          { id: 'a1', type: 'reaction', createdAt: '2026-06-30T10:00:00Z', messageID: 'm1', parentID: 'ch-unknown', parentType: 'channel' },
          { id: 'a2', type: 'reminder', createdAt: '2026-06-30T11:00:00Z', messageID: 'm2', parentID: 'ch-1', parentType: 'channel' },
        ],
        unread: 2,
      },
    });
    renderPage();
    expect(await screen.findByText('Someone')).toBeInTheDocument();
    const [reaction, reminder] = screen.getAllByTestId('activity-link');
    expect(reaction).toHaveAttribute('href', '/channel/ch-unknown#msg-m1');
    expect(reaction).toHaveTextContent('View message');
    expect(reminder).toHaveTextContent('View message');
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

  // A thread reply only renders inside its thread, so every row about one —
  // fired reminder, reaction, reply, pending reminder — links with ?thread=.
  it('links thread replies into their thread (channel and conversation)', async () => {
    mockApi({
      feed: {
        items: [
          { ...reactionItem, parentMessageID: 'root-1' },
          { ...reminderItem, parentMessageID: 'root-2' },
          { ...reactionItem, id: 'a3', type: 'thread_reply', messageID: 'm5', channelSlug: 'general', parentMessageID: 'root-5', messagePreview: 'a reply' },
        ],
        unread: 0,
      },
      reminders: [
        { id: 'r1', userID: 'u-1', messageID: 'm3', parentID: 'self-dm', parentType: 'conversation', parentMessageID: 'root-3', messagePreview: 'note to self', remindAt: '2026-07-01T09:00:00Z', createdAt: '2026-06-30T09:00:00Z' },
      ],
    });
    renderPage();
    await screen.findByText('reacted to your message');
    const hrefs = screen.getAllByTestId('activity-link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      '/channel/general?thread=root-1#msg-m1',
      '/conversation/conv-9?thread=root-2#msg-m2',
      '/channel/general?thread=root-5#msg-m5',
    ]);
    expect(screen.getByText('note to self').closest('a')).toHaveAttribute('href', '/conversation/self-dm?thread=root-3#msg-m3');
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

  it('renders mentions, thread replies, DMs and channel adds with the right labels and links', async () => {
    const base = { createdAt: '2026-06-30T10:00:00Z', parentID: 'ch-1', parentType: 'channel', channelSlug: 'general', actorID: 'u-2', read: true };
    mockApi({
      feed: {
        items: [
          { ...base, id: 'b1', type: 'mention', mentionKind: 'user', messageID: 'm1', messagePreview: 'can you share the palette?' },
          { ...base, id: 'b2', type: 'mention', mentionKind: 'all', messageID: 'm2' },
          { ...base, id: 'b3', type: 'mention', mentionKind: 'here', messageID: 'm3' },
          { ...base, id: 'b4', type: 'mention', mentionKind: 'keyword', messageID: 'm4' },
          { ...base, id: 'b5', type: 'thread_reply', messageID: 'm5', parentMessageID: 'root-1' },
          { ...base, id: 'b6', type: 'dm', parentID: 'conv-1', parentType: 'conversation', channelSlug: undefined, messageID: 'm6' },
          { ...base, id: 'b7', type: 'channel_added', messageID: '', parentName: 'design-review' },
          { ...base, id: 'b8', type: 'channel_added', messageID: '', channelSlug: 'ops', parentID: 'ch-2' },
          { ...base, id: 'b9', type: 'channel_added', messageID: '', channelSlug: undefined, parentID: 'ch-x' },
          { ...base, id: 'b10', type: 'mention', mentionKind: 'user', messageID: 'm10', actorID: 'webhook', actorName: 'Deploy Bot', webhook: true },
        ],
        unread: 0,
      },
    });
    renderPage();
    expect(await screen.findAllByText('mentioned you')).toHaveLength(2);
    for (const label of [
      'mentioned @all',
      'mentioned @here',
      'used one of your keywords',
      'replied in a thread',
      'sent you a message',
      'added you to ~design-review',
      'added you to ~ops',
      'added you to ~a channel',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // A webhook shows its own name as a bot, without a person's hover card.
    const webhookRow = rowFor('Deploy Bot');
    expect(within(webhookRow).getByLabelText('Bot')).toHaveTextContent('BOT');
    expect(within(webhookRow).queryByTestId('hovercard')).not.toBeInTheDocument();
    const hrefs = screen.getAllByTestId('activity-link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/channel/general?thread=root-1#msg-m5');
    expect(hrefs).toContain('/conversation/conv-1#msg-m6');
    expect(hrefs).toContain('/channel/general');
    expect(screen.getByText('can you share the palette?')).toBeInTheDocument();
    expect(screen.getAllByText('Open channel')).toHaveLength(3);
    // The webhook sentinel is never looked up as a user.
    const body = JSON.parse(String(calls('/api/v1/users/batch')[0][1]?.body)) as { ids: string[] };
    expect(body.ids).toEqual(['u-2']);
  });

  // A busy conversation or thread is one row, not one per message, and acting
  // on the row acts on all of its items.
  it('groups a conversation and a thread into one row each', async () => {
    const dm = { createdAt: '2026-06-30T10:00:00Z', parentID: 'conv-1', parentType: 'conversation', type: 'dm', actorID: 'u-2' };
    const reply = { createdAt: '2026-06-30T10:00:00Z', parentID: 'ch-1', parentType: 'channel', channelSlug: 'general', type: 'thread_reply', parentMessageID: 'root-1', actorID: 'u-2' };
    mockApi({
      feed: {
        items: [
          { ...dm, id: 'd3', messageID: 'm3', messagePreview: 'third', read: false },
          { ...reply, id: 't2', messageID: 'm12', messagePreview: 'second reply', read: true },
          { ...dm, id: 'd2', messageID: 'm2', messagePreview: 'second', read: false },
          { ...reply, id: 't1', messageID: 'm11', messagePreview: 'first reply', read: true },
          { ...dm, id: 'd1', messageID: 'm1', messagePreview: 'first', read: true },
        ],
        unread: 2,
      },
    });
    renderPage();
    expect(await screen.findByText('sent you messages (3)')).toBeInTheDocument();
    expect(screen.getByText('replied in a thread (2)')).toBeInTheDocument();
    expect(screen.getAllByTestId('activity-item')).toHaveLength(2);
    // The row previews and links to the newest message.
    expect(screen.getByText('third')).toHaveAttribute('href', '/conversation/conv-1#msg-m3');
    expect(screen.queryByText('second')).not.toBeInTheDocument();

    // Opening the row reads only its unread items.
    fireEvent.click(screen.getByText('third'));
    await waitFor(() => expect(calls('/api/v1/activity/items/read')).toHaveLength(1));
    expect(JSON.parse(String(calls('/api/v1/activity/items/read')[0][1]?.body))).toEqual({ ids: ['d3', 'd2'], read: true });

    // Opening a fully read row writes nothing.
    fireEvent.click(screen.getByText('second reply'));
    // Marking the read thread unread marks every reply in it.
    fireEvent.click(within(rowFor('second reply')).getByText('Mark as unread'));
    await waitFor(() => expect(calls('/api/v1/activity/items/read')).toHaveLength(2));
    expect(JSON.parse(String(calls('/api/v1/activity/items/read')[1][1]?.body))).toEqual({ ids: ['t2', 't1'], read: false });
  });

  it('marks a row read and removes a row from its menu', async () => {
    mockApi();
    renderPage();
    const row = await waitFor(() => rowFor('the deploy is green'));
    fireEvent.click(within(row).getByText('Mark as read'));
    await waitFor(() => expect(calls('/api/v1/activity/items/read')).toHaveLength(1));
    expect(JSON.parse(String(calls('/api/v1/activity/items/read')[0][1]?.body))).toEqual({ ids: ['a1'], read: true });

    fireEvent.click(within(rowFor('follow up here')).getByText('Remove from activity'));
    await waitFor(() => expect(calls('/api/v1/activity/items/remove')).toHaveLength(1));
    expect(JSON.parse(String(calls('/api/v1/activity/items/remove')[0][1]?.body))).toEqual({ ids: ['a2'] });
  });

  it('filters by type, with a dot on tabs that have unread items', async () => {
    const base = { createdAt: '2026-06-30T10:00:00Z', parentID: 'ch-1', parentType: 'channel', channelSlug: 'general', actorID: 'u-2' };
    mockApi({
      feed: {
        items: [
          { ...base, id: 'c1', type: 'mention', mentionKind: 'user', messageID: 'm1', messagePreview: 'a mention', read: false },
          { ...base, id: 'c2', type: 'dm', parentID: 'conv-1', parentType: 'conversation', messageID: 'm2', messagePreview: 'a dm', read: true },
          reminderItem,
        ],
        unread: 1,
        unreadByType: { mention: 1 },
      },
      reminders: [
        { id: 'r1', userID: 'u-1', messageID: 'm3', parentID: 'ch-1', parentType: 'channel', messagePreview: 'ping me', remindAt: '2026-07-01T09:00:00Z', createdAt: '2026-06-30T09:00:00Z' },
      ],
    });
    renderPage();
    await screen.findByText('a mention');
    expect(screen.getByTestId('activity-tab-unread-all')).toBeInTheDocument();
    expect(screen.getByTestId('activity-tab-unread-mention')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-tab-unread-dm')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'DMs' }));
    expect(screen.getByRole('tab', { name: 'DMs' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('a dm')).toBeInTheDocument();
    expect(screen.queryByText('a mention')).not.toBeInTheDocument();
    // Scheduled reminders and fired reminders live under All only.
    expect(screen.queryByTestId('pending-reminders')).not.toBeInTheDocument();
    expect(screen.queryByText('follow up here')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Reactions' }));
    expect(screen.getByTestId('activity-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    expect(screen.getByText('a mention')).toBeInTheDocument();
    expect(screen.getByTestId('pending-reminders')).toBeInTheDocument();
  });

  it('opens on the tab named in the URL', async () => {
    mockApi();
    renderPage('/activity?tab=reaction');
    expect(await screen.findByText('the deploy is green')).toBeInTheDocument();
    expect(screen.queryByText('follow up here')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Reactions/ })).toHaveAttribute('aria-selected', 'true');
  });
});
