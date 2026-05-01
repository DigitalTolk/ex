import { createElement, useMemo } from 'react';
import { Download } from 'lucide-react';
import { useAttachmentsBatch } from '@/hooks/useAttachments';
import { useAttachmentLightbox } from '@/hooks/useAttachmentLightbox';
import { iconForAttachment, isImageContentType } from '@/lib/file-helpers';
import { formatBytes } from '@/lib/format';
import type { Attachment } from '@/types';

interface MessageAttachmentsProps {
  ids: string[];
  authorName: string;
  authorAvatarURL?: string;
  // Human-readable parent label for the lightbox subtitle, e.g.
  // "~general" or "Direct message". Optional.
  postedIn?: string;
  postedAt: string;
}

export function MessageAttachments({
  ids,
  authorName,
  authorAvatarURL,
  postedIn,
  postedAt,
}: MessageAttachmentsProps) {
  const { map, isLoading } = useAttachmentsBatch(ids);

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

  if (ids.length === 0) return null;

  // Big inline thumbnail only when this message has exactly one image
  // attachment. Anything else (multiple files, mixed types, lone PDFs)
  // renders as compact attachment boxes — easier to scan and uniform.
  const onlyAttachment = ids.length === 1 ? map.get(ids[0]) : null;
  const showThumb =
    onlyAttachment &&
    onlyAttachment.url &&
    isImageContentType(onlyAttachment.contentType);

  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {showThumb ? (
          <ThumbnailButton att={onlyAttachment} onOpen={() => open(ids[0])} />
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

function ThumbnailButton({ att, onOpen }: { att: Attachment; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block max-w-xs overflow-hidden rounded-md border outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={`Open image ${att.filename}`}
      data-testid="message-image-thumb"
    >
      {att.url && (
        // Eager load: the live-tail bottom-stick logic in MessageList
        // re-pins on each img's load event. With loading="lazy" a freshly
        // posted image at the bottom of the viewport sometimes never
        // triggers the load event (browser decides it's outside the
        // near-viewport heuristic when its 0×0 placeholder is exactly at
        // the visible bottom), so the scroll never catches up to its
        // grown box.
        <img src={att.url} alt={att.filename} className="max-h-72 max-w-full" />
      )}
    </button>
  );
}

// AttachmentRow is the compact box used whenever a message has multiple
// attachments or a non-image attachment. Clicking the box opens the
// lightbox; the download icon is its own action so users don't have to
// open then download.
function AttachmentRow({ att, onOpen }: { att: Attachment; onOpen: () => void }) {
  const isImage = att.url && isImageContentType(att.contentType);
  const iconType = iconForAttachment(att.contentType, att.filename);
  return (
    <div className="flex h-12 w-64 items-center gap-1 rounded-md border bg-background pr-1 hover:bg-muted/50">
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
            src={att.url}
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
