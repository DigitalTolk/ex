import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { getDocumentNotificationCount, setDocumentNotificationCount } from '@/lib/document-title';
import { queryKeys } from '@/lib/query-keys';
import type { ActivityFeed } from '@/types';
import { NotificationCountTitleBridge } from './NotificationCountTitleBridge';

// The tab title's count — and so the app icon's — is the Activity bell's:
// every alert has its Activity row, so one number says what is waiting
// wherever it is shown. These run the real activity query.
const auth = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<object>()), apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';

function TitleConsumer() {
  useDocumentTitle('Threads');
  return null;
}

function renderBridge() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <NotificationCountTitleBridge />
      <TitleConsumer />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

const feed = (unread: number, unreadByType: ActivityFeed['unreadByType']): ActivityFeed => ({ items: [], unread, unreadByType });

describe('NotificationCountTitleBridge', () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    vi.mocked(apiFetch).mockReset();
    act(() => setDocumentNotificationCount(0));
    document.title = 'ex';
  });

  afterEach(() => {
    act(() => setDocumentNotificationCount(0));
  });

  it("shows the Activity bell's number: everything unread but reactions", async () => {
    vi.mocked(apiFetch).mockResolvedValue(feed(6, { mention: 1, channel_message: 2, channel_added: 1, reaction: 2 }) as never);
    renderBridge();
    await waitFor(() => expect(document.title).toBe('(4) Threads · ex'));
  });

  it('follows the bell as activity arrives and is read', async () => {
    vi.mocked(apiFetch).mockResolvedValue(feed(1, { dm: 1 }) as never);
    const { client } = renderBridge();
    await waitFor(() => expect(document.title).toBe('(1) Threads · ex'));
    act(() => client.setQueryData(queryKeys.activity(), feed(3, { dm: 1, thread_reply: 2 })));
    await waitFor(() => expect(document.title).toBe('(3) Threads · ex'));
    act(() => client.setQueryData(queryKeys.activity(), feed(0, {})));
    await waitFor(() => expect(document.title).toBe('Threads · ex'));
  });

  it('asks for nothing and shows no count while signed out', async () => {
    auth.isAuthenticated = false;
    renderBridge();
    await waitFor(() => expect(document.title).toBe('Threads · ex'));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('clears the count when it goes away', async () => {
    vi.mocked(apiFetch).mockResolvedValue(feed(2, { mention: 2 }) as never);
    const { unmount } = renderBridge();
    await waitFor(() => expect(document.title).toBe('(2) Threads · ex'));
    unmount();
    expect(getDocumentNotificationCount()).toBe(0);
  });
});
