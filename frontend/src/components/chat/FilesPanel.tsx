import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAttachmentsBatch } from '@/hooks/useAttachments';
import { formatBytes, formatRelative } from '@/lib/format';
import { SidePanel } from './SidePanel';
import type { UserMapEntry } from './MessageList';

interface FileEntry {
  attachmentID: string;
  messageID: string;
  authorID: string;
  createdAt: string;
}

interface FilesPanelProps {
  channelId?: string;
  conversationId?: string;
  onClose: () => void;
  userMap: Record<string, UserMapEntry>;
}

export function FilesPanel({ channelId, conversationId, onClose, userMap }: FilesPanelProps) {
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
            const author = userMap[e.authorID]?.displayName ?? 'Unknown';
            return (
              <li
                key={e.attachmentID + e.messageID}
                data-testid="files-row"
                className="flex items-start gap-3 px-2 py-2"
              >
                {a?.url && a.contentType.startsWith('image/') ? (
                  <img
                    src={a.url}
                    alt=""
                    className="h-12 w-12 rounded-md border object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded-md border bg-muted text-xs text-muted-foreground">
                    {(a?.contentType.split('/')[1] ?? 'file').slice(0, 4)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {a?.filename ?? '…'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {author} · {formatRelative(e.createdAt)}
                    {a ? ` · ${formatBytes(a.size)}` : ''}
                  </p>
                </div>
                {a?.url && (
                  <a
                    href={a.url}
                    download={a.filename}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Download ${a.filename}`}
                  >
                    <Download className="h-4 w-4" />
                  </a>
                )}
              </li>
            );
          })}
      </ul>
    </SidePanel>
  );
}
