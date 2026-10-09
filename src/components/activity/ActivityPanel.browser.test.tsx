import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ActivityPanel } from './ActivityPanel';
import { apiFetch } from '@/lib/api';
import { resetSidebarModeForTests, selectActivityRow, setActivityFilter, useSidebarModeStore } from '@/stores/sidebar-mode';
import type { ActivityItem, Reminder } from '@/types';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<object>()), apiFetch: vi.fn() }));

const DAY = 86_400_000;
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function item(over: Partial<ActivityItem> & Pick<ActivityItem, 'id' | 'type'>): ActivityItem {
  return {
    createdAt: at(60_000),
    messageID: `m-${over.id}`,
    parentID: 'ch-eng',
    parentType: 'channel',
    actorID: 'u-gunter',
    read: false,
    ...over,
  };
}

const CHANNELS = [
  { channelID: 'ch-eng', channelName: 'engineering', channelType: 'private', role: 1 },
  { channelID: 'ch-gen', channelName: 'general', channelType: 'public', role: 1 },
];
const CONVERSATIONS = [
  { conversationID: 'conv-faisal', type: 'dm', displayName: 'Faisal Khurshid' },
  { conversationID: 'conv-group', type: 'group', displayName: 'Design crew' },
];
const USERS = [
  { id: 'u-gunter', displayName: 'Günter' },
  { id: 'u-kirill', displayName: 'Kirill' },
  { id: 'u-ali', displayName: 'Ali' },
  { id: 'u-faisal', displayName: 'Faisal' },
];

interface Api {
  items?: ActivityItem[];
  reminders?: Reminder[];
  pending?: boolean;
}

function mockApi({ items = [], reminders = [], pending = false }: Api) {
  const unreadByType: Record<string, number> = {};
  for (const i of items) if (!i.read) unreadByType[i.type] = (unreadByType[i.type] ?? 0) + 1;
  const feed = { items, unread: items.filter((i) => !i.read).length, unreadByType };
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (pending) return new Promise(() => {});
    if (path === '/api/v1/activity') return feed;
    if (path === '/api/v1/reminders') return reminders;
    if (path === '/api/v1/channels') return CHANNELS;
    if (path === '/api/v1/conversations') return CONVERSATIONS;
    if (path === '/api/v1/users/batch') return USERS;
    if (path === '/api/v1/emojis') return [];
    return undefined;
  });
}

function Where() {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search + loc.hash}</span>;
}

async function renderPanel(onNavigate?: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="*"
              element={
                <div style={{ width: 340, height: 900 }}>
                  <ActivityPanel onNavigate={onNavigate} />
                  <Where />
                </div>
              }
            />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="activity-row"]')];
const rowText = () => rows().map((r) => r.textContent ?? '');
const calls = (path: string) => vi.mocked(apiFetch).mock.calls.filter((c) => c[0] === path);

describe('ActivityPanel', () => {
  beforeEach(() => {
    resetSidebarModeForTests();
    vi.mocked(apiFetch).mockReset();
  });
  afterEach(() => cleanup());

  it('shows a loading state', async () => {
    mockApi({ pending: true });
    const screen = await renderPanel();
    await expect.element(screen.getByTestId('activity-loading')).toBeVisible();
  });

  it('shows the empty state', async () => {
    mockApi({});
    const empty = await renderPanel();
    await expect.element(empty.getByText('You’re all caught up')).toBeVisible();
    await expect.element(empty.getByText('Nothing here yet.')).toBeVisible();
    // Nothing to mark read.
    expect(empty.getByTestId('activity-mark-all-read').element()).toBeDisabled();
  });

  it('labels every kind of item and folds replies, reactions and DMs into rows', async () => {
    mockApi({
      items: [
        item({ id: 'mu', type: 'mention', mentionKind: 'user', messagePreview: 'can you share the palette?' }),
        item({ id: 'ma', type: 'mention', mentionKind: 'all', parentID: 'ch-gen' }),
        item({ id: 'mh', type: 'mention', mentionKind: 'here', parentID: 'ch-unknown', parentName: 'ops' }),
        item({ id: 'mk', type: 'mention', mentionKind: 'keyword', parentID: 'ch-unknown', channelSlug: 'support' }),
        item({ id: 't1', type: 'thread_reply', parentMessageID: 'root', actorID: 'u-kirill' }),
        item({ id: 't2', type: 'thread_reply', parentMessageID: 'root', actorID: 'u-ali' }),
        item({ id: 't3', type: 'thread_reply', parentMessageID: 'root2', actorID: 'u-kirill' }),
        item({ id: 't4', type: 'thread_reply', parentMessageID: 'root2', actorID: 'u-ali' }),
        item({ id: 't5', type: 'thread_reply', parentMessageID: 'root2', actorID: 'u-gunter' }),
        item({ id: 'r1', type: 'reaction', emoji: '🚀', messageID: 'mine' }),
        item({ id: 'r2', type: 'reaction', messageID: 'mine2' }),
        item({ id: 'd1', type: 'dm', parentID: 'conv-faisal', parentType: 'conversation', actorID: 'u-faisal' }),
        item({ id: 'd2', type: 'dm', parentID: 'conv-faisal', parentType: 'conversation', actorID: 'u-faisal' }),
        item({ id: 'g1', type: 'mention', parentID: 'conv-group', parentType: 'conversation' }),
        item({ id: 'g2', type: 'mention', parentID: 'conv-unknown', parentType: 'conversation' }),
        item({ id: 'c1', type: 'channel_added', messageID: '', parentID: 'ch-x', parentName: 'design-review' }),
        item({ id: 'c2', type: 'channel_added', messageID: '', parentID: 'ch-x2', channelSlug: 'qa' }),
        item({ id: 'c3', type: 'channel_added', messageID: '', parentID: 'ch-x3' }),
        item({ id: 'rem', type: 'reminder', actorID: undefined, messagePreview: 'follow up' }),
        item({ id: 'wh', type: 'mention', actorID: 'webhook', actorName: 'Deploy Bot' }),
        item({ id: 'nobody', type: 'mention', actorID: 'u-missing' }),
        item({ id: 'future', type: 'poll' as ActivityItem['type'] }),
      ],
    });
    await renderPanel();
    await vi.waitFor(() => expect(rowText().some((t) => t.includes('Günter'))).toBe(true));
    const text = rowText();
    expect(text[0]).toContain('Günter mentioned you');
    expect(text[0]).toContain('engineering');
    expect(text[0]).toContain('can you share the palette?');
    expect(text[1]).toContain('mentioned @all');
    expect(text[1]).toContain('general');
    expect(text[2]).toContain('mentioned @here');
    expect(text[2]).toContain('ops');
    expect(text[3]).toContain('used one of your keywords');
    expect(text[3]).toContain('support');
    expect(text[4]).toContain('Kirill and 1 other replied in a thread');
    expect(text[5]).toContain('Kirill and 2 others replied in a thread');
    expect(text[6]).toContain('reacted');
    expect(text[8]).toContain('Faisal sent you 2 messages');
    expect(text[8]).toContain('Direct message');
    expect(text[9]).toContain('Design crew');
    expect(text[10]).toContain('Direct message');
    expect(text[11]).toContain('added you to #design-review');
    expect(text[12]).toContain('added you to #qa');
    expect(text[13]).toContain('added you to #a channel');
    expect(text[13]).toContain('channel');
    expect(text[14]).toContain('Reminder');
    expect(text[15]).toContain('Deploy Bot');
    expect(text[16]).toContain('Someone');
    expect(text[17]).toContain('mentioned you');
    // Unread rows carry the dot.
    expect(rows()[0].querySelector('[data-testid="activity-row-unread-dot"]')).not.toBeNull();
  });

  it('opens a row in context, marks it read and highlights it', async () => {
    const onNavigate = vi.fn();
    mockApi({
      items: [
        item({ id: 't1', type: 'thread_reply', parentMessageID: 'root' }),
        item({ id: 't2', type: 'thread_reply', parentMessageID: 'root', read: true }),
        item({ id: 'd1', type: 'dm', parentID: 'conv-faisal', parentType: 'conversation', read: true }),
        item({ id: 'nm', type: 'mention', parentID: 'ch-gen', channelSlug: undefined }),
        item({ id: 'raw', type: 'mention', parentID: 'ch-nowhere', channelSlug: undefined }),
      ],
    });
    const screen = await renderPanel(onNavigate);
    await vi.waitFor(() => expect(rows()).toHaveLength(4));

    rows()[0].querySelector<HTMLElement>('[data-testid="activity-row-open"]')!.click();
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/engineering?thread=root#msg-m-t1');
    expect(onNavigate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(calls('/api/v1/activity/items/read')).toHaveLength(1));
    expect(JSON.parse(String((calls('/api/v1/activity/items/read')[0][1] as RequestInit).body))).toEqual({ ids: ['t1', 't2'], read: true });
    expect(useSidebarModeStore.getState().selectedKey).toBe('thread:ch-eng:root');

    // An already-read row opens without another read request.
    rows()[1].querySelector<HTMLElement>('[data-testid="activity-row-open"]')!.click();
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/conversation/conv-faisal#msg-m-d1');
    expect(calls('/api/v1/activity/items/read')).toHaveLength(1);

    // Slug from the channel list, else the raw id.
    rows()[2].querySelector<HTMLElement>('[data-testid="activity-row-open"]')!.click();
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/general#msg-m-nm');
    rows()[3].querySelector<HTMLElement>('[data-testid="activity-row-open"]')!.click();
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/ch-nowhere#msg-m-raw');
  });

  it('opens without a navigate callback', async () => {
    // The item's own slug snapshot wins over the channel list.
    mockApi({ items: [item({ id: 'a', type: 'mention', read: true, channelSlug: 'eng-renamed', messagePreview: 'old news' })] });
    const screen = await renderPanel();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    rows()[0].querySelector<HTMLElement>('[data-testid="activity-row-open"]')!.click();
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/eng-renamed#msg-m-a');
  });

  it('groups rows under Today, Yesterday and Earlier', async () => {
    mockApi({
      items: [
        item({ id: 'a', type: 'mention', createdAt: at(1000) }),
        item({ id: 'b', type: 'mention', createdAt: at(1000) }),
        item({ id: 'c', type: 'mention', createdAt: new Date(new Date().setHours(12, 0, 0, 0) - DAY).toISOString() }),
        item({ id: 'd', type: 'mention', createdAt: at(10 * DAY) }),
      ],
    });
    const screen = await renderPanel();
    await expect.element(screen.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect.element(screen.getByRole('heading', { name: 'Yesterday' })).toBeVisible();
    await expect.element(screen.getByRole('heading', { name: 'Earlier' })).toBeVisible();
  });

  it('filters by tab, shows a dot on tabs with unread items, and hides read rows on request', async () => {
    mockApi({
      items: [
        item({ id: 'dm', type: 'dm', parentID: 'conv-faisal', parentType: 'conversation' }),
        item({ id: 'mention', type: 'mention', read: true }),
        item({ id: 'reaction', type: 'reaction', emoji: '👍' }),
      ],
    });
    const screen = await renderPanel();
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    expect(document.querySelector('[data-testid="activity-filter-dms-dot"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="activity-filter-reactions-dot"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="activity-filter-mentions-dot"]')).toBeNull();
    expect(document.querySelector('[data-testid="activity-filter-all-dot"]')).toBeNull();

    await screen.getByTestId('activity-filter-dms').click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByTestId('activity-filter-dms').element()).toHaveAttribute('aria-selected', 'true');
    await screen.getByRole('tab', { name: 'Reactions' }).click();
    await vi.waitFor(() => expect(rowText()[0]).toContain('reacted'));

    await screen.getByTestId('activity-filter-mentions').click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    await screen.getByTestId('activity-unread-only').click();
    await expect.element(screen.getByText('Nothing unread here.')).toBeVisible();
    // The row you have open stays listed even when read.
    selectActivityRow('item:mention');
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('marks everything read', async () => {
    mockApi({ items: [item({ id: 'a', type: 'mention' })] });
    const screen = await renderPanel();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    await screen.getByTestId('activity-mark-all-read').click();
    await vi.waitFor(() => expect(calls('/api/v1/activity/read')).toHaveLength(1));
  });

  it('marks a row read or unread from its hover actions and menu, and removes it', async () => {
    mockApi({ items: [item({ id: 'a', type: 'mention' }), item({ id: 'b', type: 'mention', read: true })] });
    const screen = await renderPanel();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));

    // DOM clicks: the hover toolbar's visibility is CSS-only and not what's
    // under test here (it's covered visually), so don't race a hover.
    screen.getByTestId('activity-row-toggle-read').first().element().click();
    await vi.waitFor(() => expect(calls('/api/v1/activity/items/read')).toHaveLength(1));
    expect(JSON.parse(String((calls('/api/v1/activity/items/read')[0][1] as RequestInit).body))).toEqual({ ids: ['a'], read: true });

    // The second row is read, so its action marks it unread.
    screen.getByTestId('activity-row-more').nth(1).element().click();
    await screen.getByTestId('activity-menu-toggle-read').last().click();
    await vi.waitFor(() => expect(calls('/api/v1/activity/items/read')).toHaveLength(2));
    expect(JSON.parse(String((calls('/api/v1/activity/items/read')[1][1] as RequestInit).body))).toEqual({ ids: ['b'], read: false });

    screen.getByTestId('activity-row-more').first().element().click();
    await screen.getByTestId('activity-menu-remove').last().click();
    await vi.waitFor(() => expect(calls('/api/v1/activity/items/remove')).toHaveLength(1));
  });

  it('lists scheduled reminders under All, opens and cancels them', async () => {
    const onNavigate = vi.fn();
    mockApi({
      reminders: [
        { id: 'r1', userID: 'u', messageID: 'm1', parentID: 'ch-gen', parentType: 'channel', messagePreview: 'ping me', remindAt: at(-DAY), createdAt: at(0) },
        { id: 'r2', userID: 'u', messageID: 'm2', parentID: 'conv-faisal', parentType: 'conversation', remindAt: at(-DAY), createdAt: at(0) },
        // A reminder on a thread reply opens it inside its thread.
        { id: 'r3', userID: 'u', messageID: 'm3', parentID: 'conv-faisal', parentType: 'conversation', parentMessageID: 'root-r', messagePreview: 'in a thread', remindAt: at(-DAY), createdAt: at(0) },
      ],
    });
    const screen = await renderPanel(onNavigate);
    await expect.element(screen.getByText('ping me')).toBeVisible();
    await expect.element(screen.getByText('A message')).toBeVisible();
    await screen.getByText('in a thread').click();
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/conversation/conv-faisal?thread=root-r#msg-m3');
    await screen.getByText('ping me').click();
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/general#msg-m1');
    expect(onNavigate).toHaveBeenCalled();
    await screen.getByTestId('cancel-reminder').first().click();
    await vi.waitFor(() => expect(calls('/api/v1/reminders/r1')).toHaveLength(1));

    // Other tabs don't show them.
    setActivityFilter('dms');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="pending-reminders"]')).toBeNull());
  });

  it('opens a reminder without a navigate callback', async () => {
    mockApi({
      reminders: [{ id: 'r1', userID: 'u', messageID: 'm1', parentID: 'ch-gen', parentType: 'channel', remindAt: at(-DAY), createdAt: at(0) }],
    });
    const screen = await renderPanel();
    await screen.getByText('A message').click();
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/general#msg-m1');
  });
});
