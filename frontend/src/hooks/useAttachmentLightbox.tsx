import { useMemo, useState, type ReactNode } from 'react';
import { ImageLightbox, type LightboxImage } from '@/components/chat/ImageLightbox';
import type { Attachment } from '@/types';

// LightboxSlide is everything the lightbox header needs to display the
// authoring context for one slide. Per-slide rather than per-component so a
// list of files from many authors (e.g. the channel files panel) can show
// the right author + timestamp on each.
export interface LightboxSlide {
  attachment: Attachment;
  authorName: string;
  authorAvatarURL?: string;
  postedAt: string;
}

export interface AttachmentLightboxSource<K> {
  key: K;
  // null when the row is not openable (no URL resolved yet, etc.).
  // Skipped when building the slide list so click handlers see a clean
  // dense index.
  slide: LightboxSlide | null;
}

export interface AttachmentLightboxOptions<K> {
  sources: AttachmentLightboxSource<K>[];
  postedIn?: string;
}

export interface AttachmentLightboxResult<K> {
  // Whether the row identified by `key` is openable. Useful for a
  // disabled/clickable affordance on the row trigger.
  isOpenable: (key: K) => boolean;
  // Open the slide for `key`. No-op if the key is not openable.
  open: (key: K) => void;
  // The lightbox itself (or null when nothing is open). Render in JSX —
  // it portals to document.body so its position in the tree is just a
  // mounting concern.
  lightbox: ReactNode;
}

export function useAttachmentLightbox<K>({
  sources,
  postedIn,
}: AttachmentLightboxOptions<K>): AttachmentLightboxResult<K> {
  const { lightboxItems, slides, indexByKey } = useMemo(() => {
    const items: LightboxImage[] = [];
    const slideOrder: LightboxSlide[] = [];
    const idx = new Map<K, number>();
    for (const { key, slide } of sources) {
      if (!slide) continue;
      idx.set(key, items.length);
      slideOrder.push(slide);
      const a = slide.attachment;
      items.push({
        url: a.url ?? '',
        downloadURL: a.downloadURL,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      });
    }
    return { lightboxItems: items, slides: slideOrder, indexByKey: idx };
  }, [sources]);

  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const openSlide = openIndex !== null ? slides[openIndex] : null;

  const lightbox: ReactNode =
    openIndex !== null && openSlide ? (
      <ImageLightbox
        open
        onClose={() => setOpenIndex(null)}
        images={lightboxItems}
        index={openIndex}
        onIndexChange={setOpenIndex}
        authorName={openSlide.authorName}
        authorAvatarURL={openSlide.authorAvatarURL}
        postedIn={postedIn}
        postedAt={openSlide.postedAt}
      />
    ) : null;

  return {
    isOpenable: (key) => indexByKey.has(key),
    open: (key) => {
      const i = indexByKey.get(key);
      if (i !== undefined) setOpenIndex(i);
    },
    lightbox,
  };
}
