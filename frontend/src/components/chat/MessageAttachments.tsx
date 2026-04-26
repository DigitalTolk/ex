import { File as FileIcon, Download } from 'lucide-react';
import { useAttachmentsBatch } from '@/hooks/useAttachments';
import { isImageContentType } from '@/lib/file-helpers';
import { formatBytes } from '@/lib/format';
import type { Attachment } from '@/types';

interface MessageAttachmentsProps {
  ids: string[];
}

export function MessageAttachments({ ids }: MessageAttachmentsProps) {
  const { map, isLoading } = useAttachmentsBatch(ids);
  if (ids.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const data = map.get(id);
        if (!data) return <AttachmentSkeleton key={id} loading={isLoading} />;
        return <AttachmentBox key={id} att={data} />;
      })}
    </div>
  );
}

function AttachmentSkeleton({ loading }: { loading: boolean }) {
  if (loading) {
    return (
      <div className="flex h-16 w-32 items-center justify-center rounded-md border bg-muted/40 text-[10px] text-muted-foreground">
        Loading…
      </div>
    );
  }
  return (
    <div className="flex h-16 w-32 items-center justify-center rounded-md border border-destructive/30 bg-destructive/5 text-[10px] text-destructive">
      Attachment unavailable
    </div>
  );
}

function AttachmentBox({ att }: { att: Attachment }) {
  if (isImageContentType(att.contentType) && att.url) {
    return (
      <a
        href={att.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-md border max-w-xs hover:opacity-90"
        aria-label={`Open image ${att.filename}`}
      >
        <img src={att.url} alt={att.filename} className="max-h-72 max-w-full" loading="lazy" />
      </a>
    );
  }

  return (
    <a
      href={att.url || '#'}
      target="_blank"
      rel="noopener noreferrer"
      download={att.filename}
      className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 hover:bg-muted/50"
      aria-label={`Download ${att.filename}`}
    >
      <FileIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-medium truncate max-w-[200px]">{att.filename}</p>
        <p className="text-[10px] text-muted-foreground">{formatBytes(att.size)}</p>
      </div>
      <Download className="ml-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
    </a>
  );
}
