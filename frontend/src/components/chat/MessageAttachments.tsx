import { createElement, useEffect, useMemo } from 'react';
import { Download } from 'lucide-react';
import { useAttachmentsBatch } from '@/hooks/useAttachments';
import { useAttachmentLightbox } from '@/hooks/useAttachmentLightbox';
import { iconForAttachment, isImageAttachment } from '@/lib/file-helpers';
import { formatBytes } from '@/lib/format';
import type { Attachment } from '@/types';

interface MessageAttachmentsProps {
  ids: string[];
  parentID?: string;
  parentType?: 'channel' | 'conversation';
  messageID: string;
  authorName: string;
  authorAvatarURL?: string;
  // Human-readable parent label for the lightbox subtitle, e.g.
  // "~general" or "Direct message". Optional.
  postedIn?: string;
  postedAt: string;
  onContentHeightChange?: () => void;
}

const THUMBNAIL_MAX_WIDTH = 320;
const THUMBNAIL_MAX_HEIGHT = 288;

export function MessageAttachments({
  ids,
  parentID,
  parentType,
  messageID,
  authorName,
  authorAvatarURL,
  postedIn,
  postedAt,
  onContentHeightChange,
}: MessageAttachmentsProps) {
  const { map, isLoading } = useAttachmentsBatch(ids, { parentID, parentType, messageID });

  // Every message attachment shares the same author + timestamp, so the
  // per-slide header info is identical for every slide.
  const sources = useMemo(
    () =>
      ids.map((id) => {
        const a = map.get(id);
        return {
          key: id,
          slide:
            a?.url
              ? { attachment: a, authorName, authorAvatarURL, postedAt }
              : null,
        };
      }),
    [ids, map, authorName, authorAvatarURL, postedAt],
  );
  const { open, lightbox } = useAttachmentLightbox({ sources, postedIn });

  useEffect(() => {
    if (!onContentHeightChange || isLoading || ids.length === 0) return;
    if (!ids.every((id) => map.has(id))) return;
    const frame = requestAnimationFrame(onContentHeightChange);
    return () => cancelAnimationFrame(frame);
  }, [ids, isLoading, map, onContentHeightChange]);

  if (ids.length === 0) return null;

  // Big inline thumbnail only when this message has exactly one image
  // attachment. Anything else (multiple files, mixed types, lone PDFs)
  // renders as compact attachment boxes — easier to scan and uniform.
  const onlyAttachment = ids.length === 1 ? map.get(ids[0]) : null;
  const showThumb =
    onlyAttachment &&
    onlyAttachment.thumbnailURL &&
    isImageAttachment(onlyAttachment.contentType, onlyAttachment.filename);

  return (
    <>
      <div className="mt-1.5 flex max-w-full flex-wrap gap-1.5">
        {showThumb ? (
          <ThumbnailButton
            att={onlyAttachment}
            onOpen={() => open(ids[0])}
            onLoad={onContentHeightChange}
          />
        ) : (
          ids.map((id) => {
            const data = map.get(id);
            if (!data) return <AttachmentSkeleton key={id} loading={isLoading} />;
            return <AttachmentRow key={id} att={data} onOpen={() => open(id)} />;
          })
        )}
      </div>
      {lightbox}
    </>
  );
}

function AttachmentSkeleton({ loading }: { loading: boolean }) {
  if (loading) {
    return (
      <div className="flex h-12 w-64 items-center justify-center rounded-md border bg-muted/40 text-xs text-muted-foreground">
        Loading…
      </div>
    );
  }
  return (
    <div className="flex h-12 w-64 items-center justify-center rounded-md border border-destructive/30 bg-destructive/5 text-xs text-destructive">
      Attachment unavailable
    </div>
  );
}

function ThumbnailButton({ att, onOpen, onLoad }: { att: Attachment; onOpen: () => void; onLoad?: () => void }) {
  // width/height attrs reserve the layout box pre-decode; CSS caps
  // visible size. Use the rendered thumbnail box, not the full
  // intrinsic image, so the reserved layout matches the chat message.
  const thumbnailDims = getThumbnailDimensions(att);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block max-w-xs overflow-hidden rounded-md border outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 max-md:max-w-full"
      aria-label={`Open image ${att.filename}`}
      data-testid="message-image-thumb"
    >
      {att.thumbnailURL && (
        <img
          src={att.thumbnailURL}
          alt={att.filename}
          className="h-auto max-h-72 max-w-full"
          width={thumbnailDims.width}
          height={thumbnailDims.height}
          onLoad={onLoad}
        />
      )}
    </button>
  );
}

function getThumbnailDimensions(att: Attachment): { width?: number; height?: number } {
  if (!att.width || !att.height) return {};
  const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / att.width, THUMBNAIL_MAX_HEIGHT / att.height);
  return {
    width: Math.round(att.width * scale),
    height: Math.round(att.height * scale),
  };
}

// AttachmentRow is the compact box used whenever a message has multiple
// attachments or a non-image attachment. Clicking the box opens the
// lightbox; the download icon is its own action so users don't have to
// open then download.
function AttachmentRow({ att, onOpen }: { att: Attachment; onOpen: () => void }) {
  const isImage = att.squareThumbnailURL && isImageAttachment(att.contentType, att.filename);
  const iconType = iconForAttachment(att.contentType, att.filename);
  return (
    <div className="flex h-12 w-64 max-w-full items-center gap-1 rounded-md border bg-background pr-1 hover:bg-muted/50 max-md:w-full">
      <button
        type="button"
        onClick={onOpen}
        disabled={!att.url}
        // outline-none + focus-visible:ring suppresses the click-focus
        // outline some browsers leave behind without taking away the
        // keyboard focus indicator.
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={`Open ${att.filename}`}
        data-testid="message-attachment-box"
      >
        {isImage ? (
          <img
            src={att.squareThumbnailURL}
            alt=""
            data-testid="message-attachment-thumb"
            className="h-8 w-8 shrink-0 rounded-sm object-cover"
            loading="lazy"
          />
        ) : (
          createElement(iconType, {
            className: 'h-4 w-4 shrink-0 text-muted-foreground',
            'aria-hidden': true,
          })
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{att.filename}</p>
          <p className="text-xs text-muted-foreground">{formatBytes(att.size)}</p>
        </div>
      </button>
      {att.url && (
        <a
          href={att.downloadURL ?? att.url}
          download={att.filename}
          aria-label={`Download ${att.filename}`}
          data-testid="message-attachment-download"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}
