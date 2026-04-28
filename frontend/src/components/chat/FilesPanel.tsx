import { createElement, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAttachmentsBatch } from '@/hooks/useAttachments';
import { useAttachmentLightbox } from '@/hooks/useAttachmentLightbox';
import { iconForAttachment, isImageContentType } from '@/lib/file-helpers';
import { formatBytes, formatRelative } from '@/lib/format';
import { SidePanel } from './SidePanel';
import type { UserMapEntry } from './MessageList';

interface FileEntry {
  attachmentID: string;
  messageID: string;
  authorID: string;
  createdAt: string;
}

// The same attachment can appear in multiple messages, so the React key
// and the index map must be keyed on (attachmentID, messageID), not the
// attachment alone.
const rowKey = (e: FileEntry) => e.attachmentID + ':' + e.messageID;

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
  const parentPath = channelId
    ? `channels/${channelId}`
    : `conversations/${conversationId}`;

  const { data: entries, isLoading } = useQuery({
    queryKey: ['files', parentPath],
    queryFn: () => apiFetch<FileEntry[]>(`/api/v1/${parentPath}/files`),
    enabled: !!(channelId || conversationId),
    // Files change when someone uploads — those propagate via the
    // message.new event. A 5-minute cache avoids re-fetching on every
    // panel toggle without compromising freshness in practice.
    staleTime: 5 * 60_000,
  });

  const ids = useMemo(() => (entries ?? []).map((e) => e.attachmentID), [entries]);
  const { map: attMap } = useAttachmentsBatch(ids);

  // Author + timestamp differ per row (same channel, many uploaders),
  // so each slide carries its own header metadata.
  const sources = useMemo(
    () =>
      (entries ?? []).map((e) => {
        const a = attMap.get(e.attachmentID);
        const author = userMap[e.authorID];
        return {
          key: rowKey(e),
          slide:
            a?.url
              ? {
                  attachment: a,
                  authorName: author?.displayName ?? 'Unknown',
                  authorAvatarURL: author?.avatarURL,
                  postedAt: e.createdAt,
                }
              : null,
        };
      }),
    [entries, attMap, userMap],
  );
  const { isOpenable, open, lightbox } = useAttachmentLightbox({ sources, postedIn });

  return (
    <SidePanel
      title="Files"
      ariaLabel="Files in this conversation"
      closeLabel="Close files panel"
      onClose={onClose}
    >
      {isLoading && (
        <p className="p-2 text-xs text-muted-foreground">Loading files…</p>
      )}
      {!isLoading && (entries?.length ?? 0) === 0 && (
        <p data-testid="files-empty" className="p-2 text-xs text-muted-foreground">
          No files have been shared here yet.
        </p>
      )}
      <ul className="divide-y" data-testid="files-list">
          {(entries ?? []).map((e) => {
            const a = attMap.get(e.attachmentID);
            const authorName = userMap[e.authorID]?.displayName ?? 'Unknown';
            const k = rowKey(e);
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
                  aria-label={a ? `Open ${a.filename}` : 'Open file'}
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
                  {a?.url && isImageContentType(a.contentType) ? (
                    <img
                      src={a.url}
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
                      {createElement(iconForAttachment(a?.contentType ?? '', a?.filename), {
                        className: 'h-6 w-6',
                        'aria-hidden': true,
                      })}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {a?.filename ?? '…'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {authorName} · {formatRelative(e.createdAt)}
                      {a ? ` · ${formatBytes(a.size)}` : ''}
                    </p>
                  </div>
                </button>
                {a?.url && (
                  <a
                    href={a.downloadURL ?? a.url}
                    download={a.filename}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
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
      {lightbox}
    </SidePanel>
  );
}
