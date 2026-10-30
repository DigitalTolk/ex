import { useEffect, useMemo, type MouseEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useAttachmentLightbox } from '@/hooks/useAttachmentLightbox';
import { useRetrySharePointLink, useSharePointLink, type SharePointParent } from '@/hooks/useSharePoint';
import { formatBytes } from '@/lib/format';
import { sharePointOpenURL } from '@/lib/sharepoint';
import { externalHref } from '@/lib/url-safety';
import type { SharePointLink } from '@/types/generated';
import { FileTypeIcon } from './FileTypeIcon';

const PROBLEMS: Record<string, string> = {
  sign_in: 'Not shared: sign in again',
  denied: "Not shared: you can't share this file",
  not_found: 'Not shared: file not found',
  unavailable: 'Not shared: Microsoft 365 unavailable',
};

// How sharing went, for the person who posted the link.
function posterNote(link: SharePointLink, nameOf: (id: string) => string): string | null {
  if (link.status === 'failed') return PROBLEMS[link.problem ?? ''] ?? 'Not shared';
  if (link.status !== 'shared') return null;
  const parts: string[] = [];
  const n = link.sharedWith ?? 0;
  if (n > 0) parts.push(`Shared with ${n} ${n === 1 ? 'person' : 'people'}`);
  const missing = link.notShared ?? [];
  if (missing.length > 0) {
    const names = missing.slice(0, 3).map(nameOf).join(', ');
    parts.push(`Not shared with ${names}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function detail(link: SharePointLink): string {
  if (link.status === 'pending') return 'Sharing…';
  if (link.file?.folder) return 'SharePoint folder';
  if (link.file) return `SharePoint · ${formatBytes(link.file.size)}`;
  return 'SharePoint';
}

interface SharePointCardProps {
  url: string;
  parent: SharePointParent;
  currentUserId?: string;
  nameOf: (userId: string) => string;
  // The lightbox header: who posted it, where and when.
  authorName: string;
  authorAvatarURL?: string;
  postedIn?: string;
  postedAt: string;
  onContentHeightChange?: () => void;
}

// SharePointCard shows a posted SharePoint link as its file. A file opens in
// the lightbox as it is, with Edit (Office for the web) and Download; a
// folder, or a modified click, opens it in SharePoint. The person who posted
// it also sees how sharing it with the channel went, and can retry a share
// that failed.
export function SharePointCard({
  url,
  parent,
  currentUserId,
  nameOf,
  authorName,
  authorAvatarURL,
  postedIn,
  postedAt,
  onContentHeightChange,
}: SharePointCardProps) {
  const { data: link } = useSharePointLink(parent, url);
  const retry = useRetrySharePointLink(parent, url);
  const previewable = link?.file && !link.file.folder ? link.file : null;
  const sources = useMemo(
    () => [
      {
        key: 'file',
        slide: previewable ? { sharePoint: { file: previewable, parent }, authorName, authorAvatarURL, postedAt } : null,
      },
    ],
    [previewable, parent, authorName, authorAvatarURL, postedAt],
  );
  const { isOpenable, open, lightbox } = useAttachmentLightbox({ sources, postedIn });
  const mine = !!link && link.posterID === currentUserId;
  // Nothing to show anyone else about a link that failed before its file
  // was known.
  const visible = !!link && (mine || !!link.file || link.status === 'pending');
  const note = visible && mine ? posterNote(link, nameOf) : null;
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => onContentHeightChange?.());
    return () => cancelAnimationFrame(frame);
  }, [visible, note, onContentHeightChange]);
  if (!visible) return null;
  const file = link.file;
  function onOpen(e: MouseEvent) {
    // A modified click keeps the link's own way: SharePoint, in a new tab.
    if (!isOpenable('file') || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open('file');
  }
  return (
    <div className="mt-1.5 max-w-md" data-testid="sharepoint-card">
      <a
        href={externalHref(sharePointOpenURL(file, url))}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onOpen}
        data-testid="sharepoint-card-open"
        className="flex h-16 items-center gap-3 overflow-hidden rounded-md border border-border bg-background p-2 dark:border-border-strong"
      >
        <FileTypeIcon
          name={file?.name ?? ''}
          mimeType={file?.mimeType}
          folder={file?.folder}
          className="h-12 w-12 rounded"
          iconClassName="h-6 w-6"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{file?.name ?? 'SharePoint'}</span>
          <span className="block truncate text-xs text-muted-foreground">{detail(link)}</span>
        </span>
      </a>
      {note && (
        <div
          role="status"
          data-testid="sharepoint-card-status"
          className="flex h-7 items-center gap-2 text-xs text-muted-foreground mobile:h-10"
        >
          <span className="min-w-0 truncate">{note}</span>
          {link.status === 'failed' && (
            <Button variant="ghost" size="xs" onClick={() => retry.mutate()} disabled={retry.isPending}>
              Retry
            </Button>
          )}
        </div>
      )}
      {lightbox}
    </div>
  );
}

interface SharePointAnchorProps {
  href: string;
  parent: SharePointParent;
  className?: string;
  children?: ReactNode;
}

// SharePointAnchor is a SharePoint link in a message's text: it opens where
// its card does, for editing when Office edits the file.
export function SharePointAnchor({ href, parent, className, children }: SharePointAnchorProps) {
  const { data: link } = useSharePointLink(parent, href);
  return (
    <a href={externalHref(sharePointOpenURL(link?.file, href))} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}
