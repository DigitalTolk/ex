import { createElement, useEffect, useState } from 'react';
import { ImageOff, X } from 'lucide-react';
import { useUnfurl, type UnfurlPreview } from '@/hooks/useUnfurl';
import { useSetNoUnfurl } from '@/hooks/useMessages';
import { useEmojiMap } from '@/hooks/useEmoji';
import { renderMarkdown } from '@/lib/markdown';
import { formatRelative, getInitials } from '@/lib/format';
import { iconForAttachment, scaleToThumbnail } from '@/lib/file-helpers';

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
  onContentHeightChange?: () => void;
}

function hasContent(preview: UnfurlPreview): boolean {
  if (preview.kind === 'message') {
    return !!(preview.authorName || preview.body || preview.image || preview.attachments?.length);
  }
  return !!(preview.title || preview.description || preview.image);
}

export function UnfurlCard({
  url,
  messageId,
  channelId,
  conversationId,
  isAuthor,
  onContentHeightChange,
}: UnfurlCardProps) {
  const { data: preview, isLoading } = useUnfurl(url);
  const { data: emojiMap } = useEmojiMap();
  const dismiss = useSetNoUnfurl();
  // imageBroken flips when the <img> element fails to load (404, network,
  // CORS). The card stays — we just swap the image slot for an inert
  // placeholder so the user doesn't see the browser's broken-image icon.
  const [imageBroken, setImageBroken] = useState(false);
  useEffect(() => {
    if (!preview || !hasContent(preview)) return;
    const frame = requestAnimationFrame(() => onContentHeightChange?.());
    return () => cancelAnimationFrame(frame);
  }, [onContentHeightChange, preview]);
  if (isLoading || !preview || !hasContent(preview)) return null;

  const dismissButton = isAuthor ? (
    <button
      type="button"
      onClick={() => dismiss.mutate({ messageId, channelId, conversationId, noUnfurl: true })}
      disabled={dismiss.isPending}
      aria-label="Remove link preview"
      data-testid="unfurl-card-dismiss"
      className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  ) : null;

  // Internal message link → rich Slack/Mattermost-style preview card. Not
  // dismissible (it's a useful inline reference, not noise), no host label,
  // and the body renders with the same markdown/mention/emoji treatment as the
  // chat. The whole card is clickable via a "stretched link" overlay (the
  // body may contain its own links, which opt back above the overlay with a
  // z-index bump so they remain individually clickable).
  if (preview.kind === 'message') {
    return (
      <div
        data-testid="unfurl-card"
        className="relative mt-1.5 flex max-w-xl flex-col gap-1.5 overflow-hidden rounded-md border border-l-4 border-l-primary bg-background p-3 dark:border-l-border-strong"
      >
        {/* Stretched link covering the whole card → navigates to the message. */}
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="unfurl-message-card"
          aria-label={`Open message from ${preview.authorName || 'Unknown'}`}
          className="absolute inset-0 z-0"
        />
        <div className="flex items-center gap-2">
          {preview.authorAvatarURL ? (
            <img
              src={preview.authorAvatarURL}
              alt=""
              width={20}
              height={20}
              loading="lazy"
              data-testid="unfurl-message-avatar"
              className="h-5 w-5 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary"
            >
              {getInitials(preview.authorName || '?')}
            </span>
          )}
          <span data-author className="truncate text-sm font-semibold">{preview.authorName || 'Unknown'}</span>
          {preview.createdAt && (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">{formatRelative(preview.createdAt)}</span>
          )}
        </div>
        {preview.body && (
          <div
            data-testid="unfurl-message-body"
            className="break-words text-sm [&_p]:whitespace-pre-wrap [&_a]:relative [&_a]:z-10"
          >
            {renderMarkdown(preview.body, { emojiMap })}
          </div>
        )}
        {preview.image && !imageBroken && (
          <img
            src={preview.image}
            alt=""
            loading="lazy"
            onError={() => setImageBroken(true)}
            data-testid="unfurl-card-image"
            // Render at the same scaled dimensions the original message uses
            // (THUMBNAIL_MAX 320×288) so a shared image isn't blown up to the
            // card width. Falls back to the CSS caps when dimensions are
            // unknown (e.g. webhook images without intrinsic size).
            {...scaleToThumbnail(preview.imageWidth, preview.imageHeight)}
            // self-start is critical: the card is a flex-col whose default
            // align-items:stretch would otherwise blow the image up to the
            // full max-w-xs width (320px) even for a small thumbnail. With
            // self-start it renders at its natural size, exactly like the
            // original message image.
            className="h-auto max-h-72 w-auto max-w-xs self-start rounded border object-contain"
          />
        )}
        {preview.attachments && preview.attachments.length > 0 && (
          <div data-testid="unfurl-card-attachments" className="flex flex-col gap-1">
            {preview.attachments.map((att, i) => (
              <div key={`${att.filename}-${i}`} className="flex items-center gap-1.5 text-sm text-muted-foreground">
                {createElement(iconForAttachment(att.contentType ?? '', att.filename), {
                  className: 'h-4 w-4 shrink-0',
                  'aria-hidden': true,
                })}
                <span className="truncate">{att.filename}</span>
              </div>
            ))}
          </div>
        )}
        {preview.channelLabel && (
          <p className="text-xs text-muted-foreground">Only visible to users in {preview.channelLabel}</p>
        )}
      </div>
    );
  }

  // Generic web link → OpenGraph card.
  return (
    <div className="relative mt-1.5 max-w-md" data-testid="unfurl-card">
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        // Per the design spec the web (OpenGraph) card is bg/base with a
        // uniform subtle border (no coloured left accent) — matches the
        // GitHub card in the reference screenshots.
        className="flex gap-3 overflow-hidden rounded-md border border-border bg-background p-2"
      >
        {preview.image && !imageBroken && (
          <img
            src={preview.image}
            alt=""
            width={64}
            height={64}
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
      {dismissButton}
    </div>
  );
}
