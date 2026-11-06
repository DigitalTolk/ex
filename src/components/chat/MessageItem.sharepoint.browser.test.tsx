import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import { SharePointHostsContext } from '@/hooks/useSharePoint';
import type { Message } from '@/types';

// A SharePoint link in a message shows as its file and opens for editing —
// the card and the link in the text alike — while other links keep their
// preview. The real hooks run; only the API is stubbed.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});
vi.mock('@/hooks/useMessages', () => ({
  usePendingMessageActions: () => ({ retry: vi.fn(), discard: vi.fn() }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSetNoUnfurl: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));
const unfurled = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useUnfurl', () => ({
  useUnfurl: (url: string | null) => {
    unfurled(url);
    return { data: url ? { url, title: `Preview of ${url}` } : null, isLoading: false };
  },
}));

const LINK = 'https://contoso.sharepoint.com/:w:/s/team/Eabc';
// A bare link shows without its scheme.
const SHOWN = 'contoso.sharepoint.com/:w:/s/team/Eabc';
const EDIT = 'https://contoso.sharepoint.com/sites/team/_layouts/15/Doc.aspx?sourcedoc=%7Bu%7D&action=edit';
// Stands in for the viewer's address: a test loads nothing from Microsoft.
const VIEWER = 'about:blank#viewer';

const sharePointCalls = () => apiFetchMock.mock.calls.filter(([path]) => String(path).startsWith('/api/v1/sharepoint/'));

function message(body: string): Message {
  return { id: 'msg-1', parentID: 'ch-1', parentType: 'channel', authorID: 'me', body, createdAt: '2026-10-30T09:00:00Z' };
}

async function renderRow(body: string, opts: { hosts?: string[]; channelId?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const userMap = new Map([['ann', { displayName: 'Ann' }]]);
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <SharePointHostsContext.Provider value={opts.hosts ?? []}>
          <MessageItem
            message={message(body)}
            authorName="Me"
            isOwn
            channelId={'channelId' in opts ? opts.channelId : 'ch-1'}
            currentUserId="me"
            userMap={userMap}
          />
        </SharePointHostsContext.Provider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  unfurled.mockReset();
  apiFetchMock.mockImplementation(async (path: string) =>
    path.startsWith('/api/v1/sharepoint/preview')
      ? { url: VIEWER }
      : path.startsWith('/api/v1/sharepoint/')
      ? {
          url: LINK,
          status: 'shared',
          posterID: 'me',
          file: { id: 'f', name: 'Plan.docx', size: 1024, webURL: 'https://contoso.sharepoint.com/Plan.docx', editURL: EDIT },
          sharedWith: 2,
          notShared: ['ann', 'ghost'],
        }
      : undefined,
  );
});
afterEach(() => cleanup());

describe('MessageItem SharePoint links', () => {
  it('shows the file, opens it for editing, and previews the other link', async () => {
    const screen = await renderRow(`plan ${LINK} and https://github.com/x`, { hosts: ['*.sharepoint.com'] });
    await expect.element(screen.getByTestId('sharepoint-card-open')).toHaveAttribute('href', EDIT);
    const text = (testId: string) => screen.container.querySelector(`[data-testid="${testId}"]`)?.textContent;
    await expect.poll(() => text('sharepoint-card-open')).toBe('Plan.docxSharePoint · 1.0 KB');
    await expect.poll(() => text('sharepoint-card-status')).toBe('Shared with 2 people · Not shared with Ann, Unknown');
    // The link in the text opens the same editor, a bare link and a
    // markdown one alike.
    await expect.element(screen.getByRole('link', { name: SHOWN, exact: true })).toHaveAttribute('href', EDIT);
    // The preview goes to the first link that isn't a SharePoint file.
    await expect.poll(() => text('unfurl-card')).toBe('Preview of https://github.com/x');
    expect(unfurled).not.toHaveBeenCalledWith(LINK);
    expect(sharePointCalls()[0][0]).toContain('/api/v1/sharepoint/link?parentType=channel&parentID=ch-1');
  });

  it('opens the file in the lightbox as it is, with Edit beside it', async () => {
    const screen = await renderRow(`plan ${LINK}`, { hosts: ['*.sharepoint.com'] });
    const text = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)?.textContent;
    const card = screen.getByTestId('sharepoint-card-open');
    await expect.poll(() => text('sharepoint-card-open')).toBe('Plan.docxSharePoint · 1.0 KB');
    await expect.element(screen.getByTestId('file-type-icon')).toHaveAttribute('data-kind', 'document');
    await card.click();
    await expect.element(screen.getByTestId('sharepoint-preview')).toHaveAttribute('src', VIEWER);
    expect(sharePointCalls().map(([path]) => path)).toContain('/api/v1/sharepoint/preview?parentType=channel&parentID=ch-1&fileID=f');
    await expect.element(screen.getByTestId('image-lightbox-edit')).toHaveAttribute('href', EDIT);
    await expect.poll(() => text('image-lightbox-toolbar')).toContain('Me');
    // Closing it leaves the message as it was.
    await screen.getByTestId('image-lightbox-close').click();
    await expect.element(screen.getByTestId('sharepoint-preview')).not.toBeInTheDocument();
    await expect.element(card).toBeVisible();
  });

  it('leaves links alone while SharePoint sharing is off', async () => {
    const screen = await renderRow(`plan ${LINK}`);
    await expect.poll(() => screen.container.querySelector('[data-testid="unfurl-card"]')?.textContent).toBe(`Preview of ${LINK}`);
    expect(screen.container.querySelector('[data-testid="sharepoint-card"]')).toBeNull();
    await expect.element(screen.getByRole('link', { name: SHOWN, exact: true })).toHaveAttribute('href', LINK);
    expect(sharePointCalls()).toHaveLength(0);
  });

  it('opens a markdown link to the file for editing too', async () => {
    const screen = await renderRow(`see [the plan](${LINK})`, { hosts: ['*.sharepoint.com'] });
    await expect.element(screen.getByRole('link', { name: 'the plan', exact: true })).toHaveAttribute('href', EDIT);
  });

  it('asks nothing for a message outside a channel or conversation', async () => {
    const screen = await renderRow(`plan ${LINK}`, { hosts: ['*.sharepoint.com'], channelId: undefined });
    await expect.element(screen.getByRole('link', { name: SHOWN, exact: true })).toHaveAttribute('href', LINK);
    expect(screen.container.querySelector('[data-testid="sharepoint-card"]')).toBeNull();
    expect(sharePointCalls()).toHaveLength(0);
  });
});
