import { useState } from 'react';
import { ImageOff, X } from 'lucide-react';
import { useUnfurl } from '@/hooks/useUnfurl';
import { useSetNoUnfurl } from '@/hooks/useMessages';

interface UnfurlCardProps {
  url: string;
  // Author-dismiss plumbing — when the viewer is the message author,
  // the card shows an X button that flips noUnfurl=true on the message
  // (server-side, visible to every viewer). Identifiers below are
  // forwarded to the mutation; either channelId or conversationId
  // is set, never both.
  messageId: string;
  channelId?: string;
  conversationId?: string;
  isAuthor: boolean;
}

export function UnfurlCard({
  url,
  messageId,
  channelId,
  conversationId,
  isAuthor,
}: UnfurlCardProps) {
  const { data: preview, isLoading } = useUnfurl(url);
  const dismiss = useSetNoUnfurl();
  // imageBroken flips when the <img> element fails to load (404, network,
  // CORS). The card stays — we just swap the image slot for an inert
  // placeholder so the user doesn't see the browser's broken-image icon.
  const [imageBroken, setImageBroken] = useState(false);
  if (isLoading || !preview) return null;
  if (!preview.title && !preview.description && !preview.image) return null;
  return (
    <div className="relative mt-1.5 max-w-md" data-testid="unfurl-card">
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex gap-3 overflow-hidden rounded-md border border-l-4 border-l-primary bg-muted/20 p-2 hover:bg-muted/40"
      >
        {preview.image && !imageBroken && (
          <img
            src={preview.image}
            alt=""
            loading="lazy"
            onError={() => setImageBroken(true)}
            data-testid="unfurl-card-image"
            className="h-16 w-16 shrink-0 rounded object-cover"
          />
        )}
        {preview.image && imageBroken && (
          <div
            data-testid="unfurl-card-image-placeholder"
            aria-hidden="true"
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground"
          >
            <ImageOff className="h-6 w-6" />
          </div>
        )}
        <div className="min-w-0 flex-1 pr-6">
          {preview.siteName && (
            <p className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {preview.siteName}
            </p>
          )}
          {preview.title && (
            <p className="truncate text-sm font-semibold">{preview.title}</p>
          )}
          {preview.description && (
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {preview.description}
            </p>
          )}
        </div>
      </a>
      {isAuthor && (
        <button
          type="button"
          onClick={() =>
            dismiss.mutate({ messageId, channelId, conversationId, noUnfurl: true })
          }
          disabled={dismiss.isPending}
          aria-label="Remove link preview"
          data-testid="unfurl-card-dismiss"
          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
