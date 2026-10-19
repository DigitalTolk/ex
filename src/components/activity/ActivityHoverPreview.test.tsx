import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityModeSwitch } from './ActivityModeSwitch';
import { apiFetch } from '@/lib/api';
import { resetSidebarModeSessionState, setActivityUnreadOnly, setSidebarMode, useSidebarModeStore } from '@/stores/sidebar-mode';
import { PREVIEW_CLOSE_DELAY_MS } from './ActivityHoverPreview';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useEmoji', () => ({ useEmojiMap: () => ({ data: {} }) }));

const feed = {
  items: [
    { id: 'a1', type: 'mention', read: false, actorID: 'u-bob', parentID: 'ch-1', parentType: 'channel', messageID: 'm1', createdAt: new Date().toISOString(), messagePreview: 'can you check?' },
    { id: 'a2', type: 'dm', read: true, actorID: 'u-bob', parentID: 'cv-1', parentType: 'conversation', messageID: 'm2', createdAt: new Date().toISOString(), messagePreview: 'lunch?' },
    // A fired reminder names nobody.
    { id: 'a3', type: 'reminder', read: true, parentID: 'ch-1', parentType: 'channel', messageID: 'm3', createdAt: new Date().toISOString(), messagePreview: 'follow up' },
  ],
  unread: 1,
  unreadByType: { mention: 1 },
};

function mockApi(overrides: Partial<Record<string, unknown>> = {}) {
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/v1/activity')) return (overrides.activity ?? feed) as never;
    if (url === '/api/v1/channels') return [{ channelID: 'ch-1', channelName: 'general', channelType: 'public' }] as never;
    if (url === '/api/v1/conversations') return [{ conversationID: 'cv-1', displayName: 'Bob', type: 'dm' }] as never;
    if (url === '/api/v1/users/batch') return [{ id: 'u-bob', displayName: 'Bob' }] as never;
    return undefined as never;
  });
}

function renderSwitch() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/channel/general']}>
        <ActivityModeSwitch />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const bell = () => screen.getByTestId('sidebar-mode-activity');
const hover = (pointerType = 'mouse') => fireEvent.pointerEnter(bell(), { pointerType });
const preview = () => screen.findByTestId('activity-preview');
// Let timers and query settles land inside act, so React's warnings stay quiet.
const idle = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe('ActivityHoverPreview', () => {
  const originalWidth = window.innerWidth;
  beforeEach(() => {
    resetSidebarModeSessionState();
    vi.mocked(apiFetch).mockReset();
    mockApi();
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  });

  it('opens on a resting mouse with the latest rows, and closes a beat after the pointer leaves', async () => {
    renderSwitch();
    expect(screen.queryByTestId('activity-preview')).toBeNull();
    hover();
    const card = await preview();
    await waitFor(() => expect(within(card).getAllByTestId('activity-row')).toHaveLength(3));
    expect(within(card).getByText('can you check?')).toBeInTheDocument();

    // Crossing from the bell into the card keeps it open.
    fireEvent.pointerLeave(bell());
    fireEvent.pointerEnter(card);
    await idle(PREVIEW_CLOSE_DELAY_MS + 50);
    expect(screen.getByTestId('activity-preview')).toBeInTheDocument();

    fireEvent.pointerLeave(card);
    await waitFor(() => expect(screen.queryByTestId('activity-preview')).toBeNull());
  });

  it('filters to unread rows on request', async () => {
    renderSwitch();
    hover();
    const card = await preview();
    await waitFor(() => expect(within(card).getAllByTestId('activity-row')).toHaveLength(3));
    fireEvent.click(screen.getByTestId('activity-preview-unreads'));
    await waitFor(() => expect(within(card).getAllByTestId('activity-row')).toHaveLength(1));
    expect(within(card).getByText('can you check?')).toBeInTheDocument();
  });

  // One Unreads setting for the card and the Activity sidebar: it used to be
  // the card's own, so the two disagreed as soon as either was switched.
  it('shares its Unreads setting with the Activity sidebar', async () => {
    act(() => setActivityUnreadOnly(true));
    renderSwitch();
    hover();
    const card = await preview();
    const toggle = screen.getByTestId('activity-preview-unreads');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(within(card).getAllByTestId('activity-row')).toHaveLength(1));
    fireEvent.click(toggle);
    expect(useSidebarModeStore.getState().unreadOnly).toBe(false);
    await waitFor(() => expect(within(card).getAllByTestId('activity-row')).toHaveLength(3));
  });

  it('opening a row reads it and closes the card; Open Activity switches the sidebar', async () => {
    renderSwitch();
    hover();
    const card = await preview();
    await waitFor(() => expect(within(card).getAllByTestId('activity-row')).toHaveLength(3));
    fireEvent.click(within(card).getAllByTestId('activity-row-open')[0]);
    await waitFor(() => expect(screen.queryByTestId('activity-preview')).toBeNull());
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/v1/activity/items/read', expect.objectContaining({ method: 'PUT' }));
    expect(useSidebarModeStore.getState().selectedKey).not.toBeNull();

    hover();
    fireEvent.click(await screen.findByTestId('activity-preview-open'));
    expect(useSidebarModeStore.getState().mode).toBe('activity');
    await waitFor(() => expect(screen.queryByTestId('activity-preview')).toBeNull());
  });

  it('stays open while a row menu is up, and the menu action lands', async () => {
    renderSwitch();
    hover();
    const card = await preview();
    await waitFor(() => expect(within(card).getAllByTestId('activity-row')).toHaveLength(3));
    fireEvent.click(within(card).getAllByTestId('activity-row-more')[0]);
    const item = await screen.findByTestId('activity-menu-toggle-read');
    // The pointer crosses out of the card to reach the menu.
    fireEvent.pointerLeave(card);
    await idle(PREVIEW_CLOSE_DELAY_MS + 50);
    expect(screen.getByTestId('activity-preview')).toBeInTheDocument();

    fireEvent.click(item);
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/v1/activity/items/read', expect.objectContaining({ method: 'PUT' })),
    );
    // The menu closed with the pointer away: the card follows.
    await waitFor(() => expect(screen.queryByTestId('activity-preview')).toBeNull());
  });

  it('"Remind me about this" from a row closes the card and opens the reminder dialog, which closes on cancel', async () => {
    renderSwitch();
    hover();
    const card = await preview();
    await waitFor(() => expect(within(card).getAllByTestId('activity-row')).toHaveLength(3));
    fireEvent.click(within(card).getAllByTestId('activity-row-more')[0]);
    fireEvent.click(await screen.findByTestId('activity-menu-remind'));
    expect(await screen.findByTestId('reminder-dialog')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('activity-preview')).toBeNull());
    fireEvent.click(screen.getByTestId('reminder-cancel'));
    await waitFor(() => expect(screen.queryByTestId('reminder-dialog')).toBeNull());
  });

  it('shows the skeleton while the feed is still loading', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url.startsWith('/api/v1/activity')) return new Promise(() => {}) as never;
      return [] as never;
    });
    renderSwitch();
    hover();
    expect(await screen.findByTestId('activity-preview-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-preview-empty')).toBeNull();
  });

  it('shows the empty state, plain and for unreads', async () => {
    mockApi({ activity: { items: [], unread: 0, unreadByType: {} } });
    renderSwitch();
    hover();
    expect(await screen.findByTestId('activity-preview-empty')).toHaveTextContent('No activity yet');
    fireEvent.click(screen.getByTestId('activity-preview-unreads'));
    expect(screen.getByTestId('activity-preview-empty')).toHaveTextContent('No unread activity');
  });

  it('stays closed for a finger, on a phone, and while the sidebar already shows Activity', async () => {
    const { unmount } = renderSwitch();
    hover('touch');
    await idle(450);
    expect(screen.queryByTestId('activity-preview')).toBeNull();

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    hover();
    await idle(450);
    expect(screen.queryByTestId('activity-preview')).toBeNull();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });

    // Hover, then leave before the delay elapses: nothing opens.
    hover();
    fireEvent.pointerLeave(bell());
    await idle(450);
    expect(screen.queryByTestId('activity-preview')).toBeNull();
    unmount();

    setSidebarMode('activity');
    renderSwitch();
    hover();
    await idle(450);
    expect(screen.queryByTestId('activity-preview')).toBeNull();
  });

  it('clicking the bell closes the preview as the sidebar switches', async () => {
    renderSwitch();
    hover();
    await preview();
    act(() => {
      fireEvent.click(bell());
    });
    expect(useSidebarModeStore.getState().mode).toBe('activity');
    expect(screen.queryByTestId('activity-preview')).toBeNull();
  });
});
