import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SharePointAnchor, SharePointCard } from './SharePointCard';
import type { SharePointLink } from '@/types/generated';

const mockLink = vi.fn();
const mockRetry = vi.fn();
let retryPending = false;
vi.mock('@/hooks/useSharePoint', () => ({
  useSharePointLink: (parent: unknown, url: string) => ({ data: mockLink(parent, url) }),
  useRetrySharePointLink: () => ({ mutate: mockRetry, isPending: retryPending }),
}));
// The lightbox has its own tests (ImageLightbox.sharepoint.browser): here,
// only what the card hands it and when it opens.
const lightboxSources = vi.hoisted(() => ({ current: [] as { key: string; slide: unknown }[], postedIn: undefined as string | undefined }));
const mockOpen = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useAttachmentLightbox', () => ({
  useAttachmentLightbox: ({ sources, postedIn }: { sources: { key: string; slide: unknown }[]; postedIn?: string }) => {
    lightboxSources.current = sources;
    lightboxSources.postedIn = postedIn;
    return { isOpenable: (k: string) => !!sources.find((x) => x.key === k && x.slide), open: mockOpen, lightbox: null };
  },
}));

const LINK = 'https://contoso.sharepoint.com/:w:/s/team/Eabc';
const FILE = {
  id: 'f-1',
  name: 'Plan.docx',
  size: 2048,
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  webURL: 'https://contoso.sharepoint.com/sites/team/Plan.docx',
  editURL: 'https://contoso.sharepoint.com/sites/team/_layouts/15/Doc.aspx?sourcedoc=%7Bu%7D&action=edit',
};
const NAMES: Record<string, string> = { u1: 'Ann', u2: 'Ben', u3: 'Cid', u4: 'Dee', u5: 'Eve' };

function renderCard(link: SharePointLink | null | undefined, viewer = 'poster') {
  mockLink.mockReturnValue(link);
  const onHeight = vi.fn();
  const view = render(
    <SharePointCard
      url={LINK}
      parent={{ channelId: 'ch-1' }}
      currentUserId={viewer}
      nameOf={(id) => NAMES[id] ?? 'Unknown'}
      authorName="Ann"
      authorAvatarURL="/a.png"
      postedIn="~plans"
      postedAt="2026-10-30T09:00:00Z"
      onContentHeightChange={onHeight}
    />,
  );
  return { ...view, onHeight };
}

beforeEach(() => {
  mockOpen.mockReset();
  mockLink.mockReset();
  mockRetry.mockReset();
  retryPending = false;
});

describe('SharePointCard', () => {
  it('shows nothing for a link that was never shared', () => {
    expect(renderCard(null).container).toBeEmptyDOMElement();
    expect(renderCard(undefined).container).toBeEmptyDOMElement();
  });

  it('opens a shared file for editing and tells the poster who has it', async () => {
    const { onHeight } = renderCard({ url: LINK, status: 'shared', posterID: 'poster', file: FILE, sharedWith: 12, notShared: ['u1', 'u2', 'u3', 'u4', 'u5'] });
    const open = screen.getByTestId('sharepoint-card-open');
    expect(open).toHaveAttribute('href', FILE.editURL);
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveTextContent('Plan.docx');
    expect(open).toHaveTextContent('SharePoint · 2.0 KB');
    expect(screen.getByTestId('sharepoint-card-status')).toHaveTextContent('Shared with 12 people · Not shared with Ann, Ben, Cid and 2 more');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // The row grows by the card: the list is told to measure it again.
    await waitFor(() => expect(onHeight).toHaveBeenCalled());
  });

  it('counts one person, and lists everyone it missed when few', () => {
    renderCard({ url: LINK, status: 'shared', posterID: 'poster', file: FILE, sharedWith: 1, notShared: ['u1'] });
    expect(screen.getByTestId('sharepoint-card-status')).toHaveTextContent('Shared with 1 person · Not shared with Ann');
  });

  it('says nothing more when it was shared with nobody and missed nobody', () => {
    renderCard({ url: LINK, status: 'shared', posterID: 'poster', file: FILE });
    expect(screen.queryByTestId('sharepoint-card-status')).toBeNull();
  });

  it('shows other members the file only', () => {
    renderCard({ url: LINK, status: 'shared', posterID: 'poster', file: FILE, sharedWith: 3 }, 'someone-else');
    expect(screen.getByTestId('sharepoint-card-open')).toHaveTextContent('Plan.docx');
    expect(screen.queryByTestId('sharepoint-card-status')).toBeNull();
  });

  it('marks a folder and a file without an Office editor', () => {
    renderCard({ url: LINK, status: 'shared', posterID: 'x', file: { ...FILE, name: 'Reports', folder: true, editURL: undefined } }, 'viewer');
    expect(screen.getByTestId('sharepoint-card-open')).toHaveTextContent('SharePoint folder');
    expect(screen.getByTestId('sharepoint-card-open')).toHaveAttribute('href', FILE.webURL);
  });

  it('says it is sharing while it is', () => {
    // The poster sees it too, with nothing more to report yet.
    const { unmount } = renderCard({ url: LINK, status: 'pending', posterID: 'poster' });
    expect(screen.getByTestId('sharepoint-card-open')).toHaveTextContent('Sharing…');
    expect(screen.queryByTestId('sharepoint-card-status')).toBeNull();
    unmount();
    renderCard({ url: LINK, status: 'pending', posterID: 'poster' }, 'someone-else');
    const open = screen.getByTestId('sharepoint-card-open');
    expect(open).toHaveTextContent('SharePoint');
    expect(open).toHaveTextContent('Sharing…');
    expect(open).toHaveAttribute('href', LINK);
  });

  it('tells the poster why it failed and lets them retry', () => {
    for (const [problem, text] of [
      ['sign_in', 'Not shared: sign in again'],
      ['denied', "Not shared: you can't share this file"],
      ['not_found', 'Not shared: file not found'],
      ['unavailable', 'Not shared: Microsoft 365 unavailable'],
      [undefined, 'Not shared'],
    ] as const) {
      const { unmount } = renderCard({ url: LINK, status: 'failed', posterID: 'poster', problem });
      expect(screen.getByTestId('sharepoint-card-status')).toHaveTextContent(text);
      expect(screen.getByTestId('sharepoint-card-open')).toHaveTextContent('SharePoint');
      unmount();
    }
    renderCard({ url: LINK, status: 'failed', posterID: 'poster', problem: 'sign_in' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRetry).toHaveBeenCalledOnce();
  });

  it('disables retry while one runs', () => {
    retryPending = true;
    renderCard({ url: LINK, status: 'failed', posterID: 'poster', problem: 'unavailable' });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('opens a file in the lightbox, and a modified click in SharePoint', () => {
    renderCard({ url: LINK, status: 'shared', posterID: 'poster', file: FILE }, 'viewer');
    expect(lightboxSources.current).toEqual([
      {
        key: 'file',
        slide: { sharePoint: { file: FILE, parent: { channelId: 'ch-1' } }, authorName: 'Ann', authorAvatarURL: '/a.png', postedAt: '2026-10-30T09:00:00Z' },
      },
    ]);
    expect(lightboxSources.postedIn).toBe('~plans');
    const open = screen.getByTestId('sharepoint-card-open');
    // fireEvent returns false once the click's default was prevented.
    expect(fireEvent.click(open)).toBe(false);
    expect(mockOpen).toHaveBeenCalledWith('file');
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
      expect(fireEvent.click(open, { [modifier]: true })).toBe(true);
    }
    expect(mockOpen).toHaveBeenCalledTimes(1);
    // Its type shows as its tile.
    expect(screen.getByTestId('file-type-icon')).toHaveAttribute('data-kind', 'document');
  });

  it('opens a folder, or a file not known yet, in SharePoint', () => {
    const { unmount } = renderCard({ url: LINK, status: 'shared', posterID: 'x', file: { ...FILE, name: 'Reports', folder: true } }, 'viewer');
    expect(fireEvent.click(screen.getByTestId('sharepoint-card-open'))).toBe(true);
    expect(screen.getByTestId('file-type-icon')).toHaveAttribute('data-kind', 'other');
    unmount();
    renderCard({ url: LINK, status: 'pending', posterID: 'poster' });
    expect(fireEvent.click(screen.getByTestId('sharepoint-card-open'))).toBe(true);
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('shows nobody else a link that failed before its file was known', () => {
    expect(renderCard({ url: LINK, status: 'failed', posterID: 'poster', problem: 'sign_in' }, 'someone-else').container).toBeEmptyDOMElement();
  });
});

describe('SharePointAnchor', () => {
  it('opens the file for editing once known, the link until then', () => {
    mockLink.mockReturnValue({ url: LINK, status: 'shared', posterID: 'p', file: FILE });
    const { rerender } = render(<SharePointAnchor href={LINK} parent={{ conversationId: 'dm-1' }} className="text-link">plan</SharePointAnchor>);
    const a = screen.getByRole('link', { name: 'plan' });
    expect(a).toHaveAttribute('href', FILE.editURL);
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveClass('text-link');
    expect(mockLink).toHaveBeenCalledWith({ conversationId: 'dm-1' }, LINK);
    mockLink.mockReturnValue(null);
    rerender(<SharePointAnchor href={LINK} parent={{ conversationId: 'dm-1' }}>plan</SharePointAnchor>);
    expect(screen.getByRole('link', { name: 'plan' })).toHaveAttribute('href', LINK);
  });
});
