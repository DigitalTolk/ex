import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { queryKeys, parentPath } from '@/lib/query-keys';
import { useAttachmentLightbox, type LightboxSlide } from '@/hooks/useAttachmentLightbox';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useLiveInView } from '@/hooks/useInView';
import { iconForAttachment, isImageContentType } from '@/lib/file-helpers';
import { formatBytes, formatRelative } from '@/lib/format';
import { canPreviewHtml } from '@/lib/html-attachment';
import { sharePointOpenURL } from '@/lib/sharepoint';
import { externalHref } from '@/lib/url-safety';
import { SearchInput } from '@/components/ui/search-input';
import { FileTypeIcon } from './FileTypeIcon';
import { HtmlPreviewButton } from './HtmlPreviewButton';
import { SidePanel } from './SidePanel';
import type { Attachment } from '@/types';
import type { SharePointFile } from '@/types/generated';
import type { UserMapEntry } from './MessageList';

// One file shared here: an attachment ready to show (the server reads the
// page's attachments in one go — the panel used to fetch them one request at a
// time, which stalled on a busy channel), or the SharePoint file a posted link
// shared.
type FileEntry = {
  attachmentID: string;
  messageID: string;
  authorID: string;
  createdAt: string;
} & ({ attachment: Attachment; sharePoint?: undefined } | { attachment?: undefined; sharePoint: SharePointFile });

interface FilePage {
  files: FileEntry[];
  nextCursor?: string;
}

const SEARCH_DEBOUNCE_MS = 250;

// The same attachment can appear in multiple messages, so the React key
// and the index map must be keyed on (attachmentID, messageID), not the
// attachment alone.
const rowKey = (e: FileEntry) => `${e.attachmentID}:${e.messageID}`;

interface FilesPanelProps {
  channelId?: string;
  conversationId?: string;
  onClose: () => void;
  userMap: Record<string, UserMapEntry>;
  // Human-readable parent label for the lightbox header subtitle, e.g.
  // "~general" or "Direct message". Optional.
  postedIn?: string;
}

export function FilesPanel({
  channelId,
  conversationId,
  onClose,
  userMap,
  postedIn,
}: FilesPanelProps) {
  const parent = useMemo(() => ({ channelId, conversationId }), [channelId, conversationId]);
  const path = parentPath(parent);
  const [query, setQuery] = useState('');
  const term = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);

  const { data, isPending, isError, isPlaceholderData, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    queryKey: queryKeys.files(path, term),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (term) params.set('q', term);
      if (pageParam) params.set('cursor', pageParam);
      const qs = params.toString();
      return apiFetch<FilePage>(`/api/v1/${path}/files${qs ? `?${qs}` : ''}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor || undefined,
    enabled: !!(channelId || conversationId),
    // The last results stay up while the next search loads.
    placeholderData: keepPreviousData,
    // New files arrive with message.new (an upload) and sharepoint.changed
    // (a shared link), which refetch the list; the cache spares a fetch on
    // every panel toggle.
    staleTime: 5 * 60_000,
  });
  const entries = useMemo(() => data?.pages.flatMap((p) => p.files) ?? [], [data]);

  // The next page loads once the end of the list scrolls into view (and
  // again while it stays in view, until the list fills the panel).
  const endRef = useRef<HTMLDivElement>(null);
  const atEnd = useLiveInView(endRef);
  useEffect(() => {
    if (atEnd && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [atEnd, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Author + timestamp differ per row (same channel, many uploaders),
  // so each slide carries its own header metadata. SharePoint files are
  // slides too (a folder opens in SharePoint instead).
  const sources = useMemo(
    () =>
      entries.map((e) => {
        const author = userMap[e.authorID];
        const header = { authorName: author?.displayName ?? 'Unknown', authorAvatarURL: author?.avatarURL, postedAt: e.createdAt };
        let slide: LightboxSlide | null = null;
        if (e.sharePoint) {
          if (!e.sharePoint.folder) slide = { ...header, sharePoint: { file: e.sharePoint, parent } };
        } else if (e.attachment.url) {
          slide = { ...header, attachment: e.attachment };
        }
        return { key: rowKey(e), slide };
      }),
    [entries, userMap, parent],
  );
  const { isOpenable, open, lightbox } = useAttachmentLightbox({ sources, postedIn });

  const settled = !isPending && !isError && !isPlaceholderData;
  return (
    <SidePanel
      title="Files"
      ariaLabel="Files in this conversation"
      closeLabel="Close files panel"
      onClose={onClose}
      toolbar={
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files"
          aria-label="Search files"
          className="h-9"
          data-testid="files-search"
        />
      }
    >
      {isPending && (
        <p className="p-2 text-xs text-muted-foreground">Loading files…</p>
      )}
      {isError && (
        <p role="alert" data-testid="files-error" className="p-2 text-xs text-destructive">
          Couldn&apos;t load files.
        </p>
      )}
      {settled && entries.length === 0 && (
        <p data-testid="files-empty" className="p-2 text-xs text-muted-foreground">
          {term ? 'No matching files.' : 'No files have been shared here yet.'}
        </p>
      )}
      <ul className="divide-y" data-testid="files-list">
          {entries.map((e) => {
            const authorName = userMap[e.authorID]?.displayName ?? 'Unknown';
            const k = rowKey(e);
            if (e.sharePoint) {
              return (
                <SharePointFileRow
                  key={k}
                  file={e.sharePoint}
                  authorName={authorName}
                  createdAt={e.createdAt}
                  onOpen={isOpenable(k) ? () => open(k) : undefined}
                />
              );
            }
            const a = e.attachment;
            const canOpen = isOpenable(k);
            return (
              <li
                key={k}
                data-testid="files-row"
                className="flex items-center gap-3 px-2 py-2"
              >
                <button
                  type="button"
                  disabled={!canOpen}
                  onClick={() => open(k)}
                  aria-label={`Open ${a.filename}`}
                  data-testid="files-row-open"
                  // min-w-0: the truncate-inside-flex chain only works if
                  // every flex-item ancestor allows shrinking past
                  // intrinsic min-content. Without this the long
                  // filename pushes the `shrink-0` download icon off the
                  // panel edge.
                  // outline-none + focus-visible:ring keeps keyboard
                  // a11y while suppressing the click-focus outline some
                  // browsers (notably Safari) leave behind after a tap.
                  className="flex flex-1 min-w-0 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {a.squareThumbnailURL && isImageContentType(a.contentType) ? (
                    <img
                      src={a.squareThumbnailURL}
                      alt=""
                      data-testid="files-row-thumb"
                      className="h-12 w-12 rounded-md border object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div
                      data-testid="files-row-icon"
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"
                    >
                      {createElement(iconForAttachment(a.contentType, a.filename), {
                        className: 'h-6 w-6',
                        'aria-hidden': true,
                      })}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {a.filename}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {authorName} · {formatRelative(e.createdAt)} · {formatBytes(a.size)}
                    </p>
                  </div>
                </button>
                {canPreviewHtml(a) && (
                  <HtmlPreviewButton
                    attachment={a}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground mobile:p-2.5"
                    iconClassName="h-4 w-4"
                  />
                )}
                {a.url && (
                  <a
                    href={a.downloadURL ?? a.url}
                    download={a.filename}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground mobile:p-2.5"
                    aria-label={`Download ${a.filename}`}
                    data-testid="files-row-download"
                  >
                    <Download className="h-4 w-4" />
                  </a>
                )}
              </li>
            );
          })}
      </ul>
      <div ref={endRef} aria-hidden="true" data-testid="files-end" />
      {isFetchingNextPage && (
        <p className="p-2 text-xs text-muted-foreground">Loading more…</p>
      )}
      {lightbox}
    </SidePanel>
  );
}

interface SharePointFileRowProps {
  file: SharePointFile;
  authorName: string;
  createdAt: string;
  // Opens the file in the lightbox; a folder has none and opens in
  // SharePoint.
  onOpen?: () => void;
}

// A SharePoint file a posted link shared.
function SharePointFileRow({ file, authorName, createdAt, onOpen }: SharePointFileRowProps) {
  const className =
    'flex flex-1 min-w-0 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
  const body = (
    <>
      <FileTypeIcon
        name={file.name}
        mimeType={file.mimeType}
        folder={file.folder}
        className="h-12 w-12 rounded-md"
        iconClassName="h-6 w-6"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{file.name}</p>
        <p className="text-xs text-muted-foreground">
          {authorName} · {formatRelative(createdAt)} · SharePoint
        </p>
      </div>
    </>
  );
  return (
    <li data-testid="files-row" className="flex items-center gap-3 px-2 py-2">
      {onOpen ? (
        <button type="button" onClick={onOpen} aria-label={`Open ${file.name}`} data-testid="files-row-open" className={className}>
          {body}
        </button>
      ) : (
        <a
          href={externalHref(sharePointOpenURL(file, file.webURL))}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${file.name}`}
          data-testid="files-row-open"
          className={className}
        >
          {body}
        </a>
      )}
    </li>
  );
}
