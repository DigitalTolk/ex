import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ActivityPanel } from './ActivityPanel';
import { apiFetch } from '@/lib/api';
import { applyRemindersChangedEvent } from '@/hooks/useActivity';
import { resetSidebarModeSessionState, setActivityFilter, useSidebarModeStore } from '@/stores/sidebar-mode';
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

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="go" onClick={() => navigate(to)}>
      go
    </button>
  );
}

// Tall enough by default that every row of the label tests renders; the
// virtualization test passes a short one.
let client: QueryClient;

async function renderPanel(onNavigate?: () => void, height = 4000) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client = qc;
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="*"
              element={
                <div style={{ width: 340, height }}>
                  <ActivityPanel onNavigate={onNavigate} />
                  <Where />
                  <GoTo to="/threads" />
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

const readBodies = () =>
  calls('/api/v1/activity/items/read').map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { ids: string[]; read: boolean });
// Rows highlighted as the page on screen (the class itself, not its hover variant).
const highlighted = () =>
  rows().flatMap((r, i) => (r.className.split(/\s+/).includes('bg-sidebar-accent') ? [i] : []));
const open = (i: number) => rows()[i].querySelector<HTMLElement>('[data-testid="activity-row-open"]')!.click();

describe('ActivityPanel', () => {
  beforeEach(() => {
    resetSidebarModeSessionState();
    vi.mocked(apiFetch).mockReset();
  });
  afterEach(() => cleanup());

  it('shows a loading state', async () => {
    mockApi({ pending: true });
    const screen = await renderPanel();
    await expect.element(screen.getByTestId('activity-loading')).toBeVisible();
  });

  it('shows a one-line empty state, and nothing to mark read', async () => {
    mockApi({});
    const empty = await renderPanel();
    await expect.element(empty.getByTestId('activity-empty')).toHaveTextContent('No activity');
    expect(empty.getByTestId('activity-mark-all-read').element()).toBeDisabled();
  });

  // A feed that fails to load must not pass for an empty one.
  it('says when the feed failed to load and retries', async () => {
    mockApi({});
    const ok = vi.mocked(apiFetch).getMockImplementation()!;
    let fail = true;
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/v1/activity' && fail) throw new Error('500');
      return ok(path, init);
    });
    const screen = await renderPanel();
    await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.getByTestId('activity-error').element().textContent).toContain('Couldn’t load activity');
    expect(document.querySelector('[data-testid="activity-empty"]')).toBeNull();
    fail = false;
    await screen.getByRole('button', { name: 'Try again' }).click();
    await expect.element(screen.getByTestId('activity-empty')).toBeVisible();
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
        item({ id: 'r1b', type: 'reaction', emoji: '🚀', messageID: 'mine', actorID: 'u-ali' }),
        item({ id: 'r2', type: 'reaction', messageID: 'mine2' }),
        item({ id: 'd1', type: 'dm', parentID: 'conv-faisal', parentType: 'conversation', actorID: 'u-faisal' }),
        item({ id: 'd2', type: 'dm', parentID: 'conv-faisal', parentType: 'conversation', actorID: 'u-faisal' }),
        item({ id: 'g1', type: 'mention', parentID: 'conv-group', parentType: 'conversation' }),
        item({ id: 'g2', type: 'mention', parentID: 'conv-unknown', parentType: 'conversation' }),
        item({ id: 'c1', type: 'channel_added', messageID: '', parentID: 'ch-x', parentName: 'design-review' }),
        item({ id: 'c2', type: 'channel_added', messageID: '', parentID: 'ch-x2', channelSlug: 'qa' }),
        item({ id: 'c3', type: 'channel_added', messageID: '', parentID: 'ch-x3' }),
        item({ id: 'rem', type: 'reminder', actorID: undefined, messagePreview: 'follow up' }),
        item({ id: 'wh', type: 'mention', actorID: 'webhook', actorName: 'Deploy Bot', webhook: true }),
        item({ id: 'nobody', type: 'mention', actorID: 'u-missing' }),
        item({ id: 'future', type: 'poll' as ActivityItem['type'] }),
      ],
    });
    await renderPanel();
    await vi.waitFor(() => expect(rowText().some((t) => t.includes('Günter'))).toBe(true));
    await vi.waitFor(() => expect(rows()).toHaveLength(18));
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
    // The same emoji on one message is one row.
    expect(text[6]).toContain('Günter and 1 other reacted');
    expect(text[7]).toContain('reacted');
    expect(text[8]).toContain('Faisal sent you 2 messages');
    expect(text[8]).toContain('Direct message');
    // A group DM shows its name; a 1:1 (or unknown) one says it's direct.
    expect(text[9]).toContain('Design crew');
    expect(text[10]).toContain('Direct message');
    // Channels are ~name, never #name.
    expect(text[11]).toContain('added you to ~design-review');
    expect(text[12]).toContain('added you to ~qa');
    expect(text[13]).toContain('added you to ~a channel');
    expect(text.join(' ')).not.toContain('#');
    expect(text[14]).toContain('Reminder');
    expect(text[15]).toContain('Deploy Bot');
    expect(text[16]).toContain('Someone');
    // A type this client doesn't know is named, not mislabelled as a mention.
    expect(text[17]).toContain('Günter');
    expect(text[17]).not.toContain('mentioned you');
    // Unread rows carry the dot and say so to a screen reader.
    expect(rows()[0].querySelector('[data-testid="activity-row-unread-dot"]')).not.toBeNull();
    expect(rows()[0].textContent).toContain('Unread:');
    // A known channel gets its icon; an unknown one only its name.
    expect(rows()[0].querySelector('svg.lucide-lock')).not.toBeNull();
    expect(rows()[1].querySelector('svg.lucide-globe')).not.toBeNull();
    expect(rows()[2].querySelector('svg.lucide-globe, svg.lucide-lock')).toBeNull();
  });

  // A webhook's name is whatever the webhook chose: it must read as a bot, not
  // a person, and is never looked up as a user.
  it('marks a webhook row as a bot', async () => {
    mockApi({
      items: [
        item({ id: 'wh', type: 'mention', actorID: 'webhook', actorName: 'IT Support', webhook: true }),
        item({ id: 'p', type: 'mention' }),
      ],
    });
    await renderPanel();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0].querySelector('[data-testid="activity-row-bot"]')).toHaveTextContent('BOT');
    expect(rows()[0].querySelector('svg.lucide-bot')).not.toBeNull();
    expect(rows()[1].querySelector('[data-testid="activity-row-bot"]')).toBeNull();
    await vi.waitFor(() => expect(calls('/api/v1/users/batch').length).toBeGreaterThan(0));
    for (const c of calls('/api/v1/users/batch')) {
      expect(JSON.parse(String((c[1] as RequestInit).body)).ids).not.toContain('webhook');
    }
  });

  it('opens a row in context, marks it read and highlights it while it is the page', async () => {
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

    open(0);
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/engineering?thread=root#msg-m-t1');
    expect(onNavigate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(readBodies()).toHaveLength(1));
    expect(readBodies()[0]).toEqual({ ids: ['t1'], read: true });
    expect(useSidebarModeStore.getState().selectedKey).toBe('thread:ch-eng|root');
    await vi.waitFor(() => expect(highlighted()).toEqual([0]));

    // An already-read row opens without another read request.
    open(1);
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/conversation/conv-faisal#msg-m-d1');
    expect(readBodies()).toHaveLength(1);

    // Slug from the channel list, else the raw id.
    open(2);
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/general#msg-m-nm');
    open(3);
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/ch-nowhere#msg-m-raw');

    // Going somewhere else lets the highlight go.
    await screen.getByTestId('go').click();
    await vi.waitFor(() => expect(highlighted()).toEqual([]));
  });

  // A renamed channel's snapshot slug may now name another channel: the
  // channel list (by id) wins.
  it('links by the channel id first, falling back to the snapshot slug', async () => {
    mockApi({
      items: [
        item({ id: 'a', type: 'mention', read: true, channelSlug: 'eng-old-name' }),
        item({ id: 'b', type: 'mention', read: true, parentID: 'ch-gone', channelSlug: 'kept-slug' }),
      ],
    });
    const screen = await renderPanel();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    open(0);
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/engineering#msg-m-a');
    open(1);
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/kept-slug#msg-m-b');
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

  it('filters by tab (arrow keys too), shows a dot on tabs with unread items, and hides read rows on request', async () => {
    mockApi({
      items: [
        item({ id: 'dm', type: 'dm', parentID: 'conv-faisal', parentType: 'conversation' }),
        item({ id: 'mention', type: 'mention', read: true }),
        item({ id: 'reaction', type: 'reaction', emoji: '👍' }),
      ],
    });
    const screen = await renderPanel();
    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    expect(document.querySelector('[data-testid="activity-filter-dm-dot"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="activity-filter-reaction-dot"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="activity-filter-mention-dot"]')).toBeNull();
    expect(document.querySelector('[data-testid="activity-filter-all-dot"]')).toBeNull();
    // The dot is announced through the tab's name.
    await expect.element(screen.getByRole('tab', { name: 'DMs, unread' })).toBeInTheDocument();

    await screen.getByTestId('activity-filter-dm').click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByTestId('activity-filter-dm').element()).toHaveAttribute('aria-selected', 'true');
    // Arrow keys move between tabs (and select them).
    await userEvent.keyboard('{ArrowRight}');
    await vi.waitFor(() => expect(useSidebarModeStore.getState().filter).toBe('mention'));
    await screen.getByRole('tab', { name: /Reactions/ }).click();
    await vi.waitFor(() => expect(rowText()[0]).toContain('reacted'));
    await screen.getByRole('tab', { name: 'All' }).click();
    await vi.waitFor(() => expect(rows()).toHaveLength(3));

    await screen.getByTestId('activity-filter-mention').click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    await screen.getByTestId('activity-unread-only').click();
    await expect.element(screen.getByTestId('activity-empty')).toHaveTextContent('No unread activity');
  });

  // The row you opened stays listed under "Unread only" while it's the page
  // on screen — and only then.
  it('keeps the open row under Unread only until you leave it', async () => {
    mockApi({ items: [item({ id: 'a', type: 'mention' }), item({ id: 'b', type: 'mention', read: true })] });
    const screen = await renderPanel();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await screen.getByTestId('activity-unread-only').click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    open(0);
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/engineering#msg-m-a');
    await vi.waitFor(() => expect(rows()[0]?.getAttribute('data-unread')).toBe('false'));
    expect(rows()).toHaveLength(1);
    await screen.getByTestId('go').click();
    await vi.waitFor(() => expect(rows()).toHaveLength(0));
  });

  it('marks everything read on All', async () => {
    mockApi({ items: [item({ id: 'a', type: 'mention' })] });
    const screen = await renderPanel();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    await screen.getByTestId('activity-mark-all-read').click();
    await vi.waitFor(() => expect(calls('/api/v1/activity/read')).toHaveLength(1));
    await vi.waitFor(() => expect(rows()[0].getAttribute('data-unread')).toBe('false'));
  });

  // "Mark all as read" on a tab clears that tab only — it used to advance the
  // global watermark, wiping every other tab and any deliberate "Mark as
  // unread".
  it('marks only the tab on screen read', async () => {
    mockApi({
      items: [
        item({ id: 'm1', type: 'mention' }),
        item({ id: 'm2', type: 'mention' }),
        item({ id: 'd1', type: 'dm', parentID: 'conv-faisal', parentType: 'conversation' }),
        item({ id: 'x1', type: 'reaction', read: true }),
      ],
    });
    const screen = await renderPanel();
    await vi.waitFor(() => expect(rows()).toHaveLength(4));
    await screen.getByTestId('activity-filter-mention').click();
    await screen.getByTestId('activity-mark-all-read').click();
    await vi.waitFor(() => expect(readBodies()).toHaveLength(1));
    expect(readBodies()[0]).toEqual({ ids: ['m1', 'm2'], read: true });
    expect(calls('/api/v1/activity/read')).toHaveLength(0);
    // A tab with nothing unread has nothing to mark.
    await screen.getByTestId('activity-filter-reaction').click();
    await vi.waitFor(() => expect(screen.getByTestId('activity-mark-all-read').element()).toBeDisabled());
  });

  it('marks a row read or unread from its hover actions and menu, and removes it', async () => {
    mockApi({
      items: [
        item({ id: 'a', type: 'mention' }),
        item({ id: 'd2', type: 'dm', parentID: 'conv-faisal', parentType: 'conversation', read: true }),
        item({ id: 'd1', type: 'dm', parentID: 'conv-faisal', parentType: 'conversation', read: true }),
      ],
    });
    const screen = await renderPanel();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));

    // DOM clicks: the hover toolbar's visibility is CSS-only and not what's
    // under test here, so don't race a hover.
    screen.getByTestId('activity-row-toggle-read').first().element().click();
    await vi.waitFor(() => expect(readBodies()).toHaveLength(1));
    expect(readBodies()[0]).toEqual({ ids: ['a'], read: true });

    // Marking a busy conversation unread marks its newest message, so the row
    // reads unread without every message counting again.
    screen.getByTestId('activity-row-more').nth(1).element().click();
    await screen.getByTestId('activity-menu-toggle-read').last().click();
    await vi.waitFor(() => expect(readBodies()).toHaveLength(2));
    expect(readBodies()[1]).toEqual({ ids: ['d2'], read: false });

    // Removing a row removes all of it.
    screen.getByTestId('activity-row-more').nth(1).element().click();
    await screen.getByTestId('activity-menu-remove').last().click();
    await vi.waitFor(() => expect(calls('/api/v1/activity/items/remove')).toHaveLength(1));
    expect(JSON.parse(String((calls('/api/v1/activity/items/remove')[0][1] as RequestInit).body))).toEqual({ ids: ['d2', 'd1'] });
  });

  // Hundreds of rows: only those near the viewport mount, and scrolling the
  // panel brings in the rest.
  it('renders only the rows near the viewport and follows the panel scroll', async () => {
    const items = Array.from({ length: 300 }, (_, i) =>
      item({ id: `n${String(i).padStart(3, '0')}`, type: 'mention', read: true, messagePreview: `note ${i}` }),
    );
    mockApi({ items });
    const screen = await renderPanel(undefined, 600);
    await expect.element(screen.getByText('note 0', { exact: true })).toBeVisible();
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(300);
    const viewport = document.querySelector<HTMLElement>('[data-testid="activity-scroll-area"] [data-slot="scroll-area-viewport"]')!;
    await vi.waitFor(
      () => {
        viewport.scrollTop = viewport.scrollHeight;
        expect(document.body.textContent).toContain('note 299');
      },
      { timeout: 20_000, interval: 100 },
    );
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
    setActivityFilter('dm');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="pending-reminders"]')).toBeNull());
  });

  // Leaving the channel, or the message being deleted or edited, changes
  // reminders on the server; its reminders.changed nudge brings the list in line.
  it('drops and re-previews reminders when the server reports them changed', async () => {
    const reminder = (id: string, messagePreview: string): Reminder => ({
      id, userID: 'u', messageID: `m-${id}`, parentID: 'ch-gen', parentType: 'channel', messagePreview, remindAt: at(-DAY), createdAt: at(0),
    });
    mockApi({ reminders: [reminder('r1', 'left channel text'), reminder('r2', 'before the edit')] });
    const screen = await renderPanel();
    await expect.element(screen.getByText('left channel text')).toBeVisible();

    mockApi({ reminders: [reminder('r2', 'after the edit')] });
    applyRemindersChangedEvent(client);
    await expect.element(screen.getByText('after the edit')).toBeVisible();
    expect(document.body.textContent).not.toContain('left channel text');
    expect(document.body.textContent).not.toContain('before the edit');
    // The feed itself was left alone.
    expect(calls('/api/v1/activity')).toHaveLength(1);
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
