import { useState, type ReactNode } from 'react';

// An MP4 attachment, played in the lightbox with the platform's own controls.
// Nothing plays until it is asked to; only the metadata loads up front, and
// the server answers the byte ranges a player seeks with. A file the browser
// can't play (a codec it lacks) shows `fallback`, the download card.
export function VideoPreview({ url, fallback }: { url: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    <video
      src={url}
      controls
      playsInline
      preload="metadata"
      onError={() => setFailed(true)}
      data-testid="image-lightbox-video-player"
      className="max-h-full max-w-full rounded-md bg-black shadow-2xl"
    />
  );
}
