import { File as FileIcon, X } from 'lucide-react';
import { isImageContentType } from '@/lib/file-helpers';
import { formatBytes } from '@/lib/format';

interface DraftAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  // localURL is an object URL for instant preview before the server has
  // finished processing the upload.
  localURL?: string;
}

interface AttachmentChipProps {
  att: DraftAttachment;
  onRemove?: () => void;
}

export function AttachmentChip({ att, onRemove }: AttachmentChipProps) {
  const isImage = isImageContentType(att.contentType);
  return (
    <div className="group relative flex items-center gap-2 rounded-md border bg-background p-1.5 pr-2 shadow-sm">
      <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-muted flex items-center justify-center">
        {isImage && att.localURL ? (
          <img src={att.localURL} alt="" className="h-full w-full object-cover" />
        ) : (
          <FileIcon className="h-5 w-5 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium truncate max-w-[180px]">{att.filename}</p>
        <p className="text-[10px] text-muted-foreground">
          {formatBytes(att.size)}
        </p>
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
