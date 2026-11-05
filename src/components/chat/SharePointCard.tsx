import { useEffect, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  onContentHeightChange?: () => void;
}

// SharePointCard shows a posted SharePoint link as its file. It opens in
// SharePoint, in a new tab — for editing, where Office for the web edits it —
// and a file downloads from the button beside it. The person who posted it
// also sees how sharing it with the channel went, and can retry a share that
// failed.
export function SharePointCard({ url, parent, currentUserId, nameOf, onContentHeightChange }: SharePointCardProps) {
  const { data: link } = useSharePointLink(parent, url);
  const retry = useRetrySharePointLink(parent, url);
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
  // From SharePoint, in a new tab (the browser there holds the Microsoft
  // sign-in). A folder, or an item Microsoft 365 gave no ids, has none.
  const download = file && !file.folder ? file.downloadURL : undefined;
  return (
    <div className="mt-1.5 max-w-md" data-testid="sharepoint-card">
      <div className="flex h-16 items-center gap-1 overflow-hidden rounded-md border border-border bg-background p-2 dark:border-border-strong">
        <a
          href={externalHref(sharePointOpenURL(file, url))}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="sharepoint-card-open"
          className="flex min-w-0 flex-1 items-center gap-3"
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
        {download && (
          <a
            href={externalHref(download)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Download ${file!.name}`}
            title="Download"
            data-testid="sharepoint-card-download"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground mobile:h-10 mobile:w-10"
          >
            <Download className="h-4 w-4" />
          </a>
        )}
      </div>
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
