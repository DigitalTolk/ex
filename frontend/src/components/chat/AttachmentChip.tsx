import { File as FileIcon, X } from 'lucide-react';
import { isImageContentType } from '@/lib/file-helpers';
import { formatBytes } from '@/lib/format';

interface DraftAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  // Object-URL preview for the local file, valid until upload completes.
  localURL?: string;
  // [0, 1] while uploading; undefined or 1 means done.
  progress?: number;
}

interface AttachmentChipProps {
  att: DraftAttachment;
  onRemove?: () => void;
}

export function AttachmentChip({ att, onRemove }: AttachmentChipProps) {
  const isImage = isImageContentType(att.contentType);
  const uploading = att.progress !== undefined && att.progress < 1;
  const pct = Math.max(0, Math.min(1, att.progress ?? 1));
  return (
    <div
      data-testid="attachment-chip"
      data-uploading={uploading ? 'true' : undefined}
      className="group relative flex w-64 items-center gap-2 rounded-md border bg-background p-1.5 pr-2 shadow-sm"
    >
      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded bg-muted flex items-center justify-center">
        {isImage && att.localURL ? (
          <img
            src={att.localURL}
            alt=""
            className={`h-full w-full object-cover ${uploading ? 'opacity-60' : ''}`}
          />
        ) : (
          <FileIcon className="h-5 w-5 text-muted-foreground" aria-hidden />
        )}
        {uploading && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/40"
            aria-hidden
          >
            <span className="text-[10px] font-semibold text-foreground tabular-nums">
              {Math.round(pct * 100)}%
            </span>
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate">{att.filename}</p>
        <p className="text-xs text-muted-foreground">
          {formatBytes(att.size)}
        </p>
        {uploading && (
          <div
            role="progressbar"
            aria-label={`Uploading ${att.filename}`}
            aria-valuenow={Math.round(pct * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1 h-1 w-full overflow-hidden rounded bg-muted"
          >
            <div
              className="h-full bg-primary transition-[width] duration-150"
              style={{ width: `${pct * 100}%` }}
            />
          </div>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${att.filename}`}
          className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm opacity-0 transition-opacity hover:text-foreground hover:bg-muted group-hover:opacity-100 focus:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export type { DraftAttachment };
