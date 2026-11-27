import { useState } from 'react';
import { fitSize, storedSize } from '@/lib/gif-size';
import { giphyFileURL, giphyPageURL } from '@/lib/giphy';

interface GiphyGifProps {
  // A GIPHY id isGiphyId accepted.
  id: string;
  width?: number;
  height?: number;
  onMediaLoad?: () => void;
}

// GiphyGif shows a GIF picked from GIPHY before ohmagif replaced it,
// straight from GIPHY's files (lib/giphy), in a box of the size the message
// kept. A GIF GIPHY no longer has keeps its box, unavailable.
export function GiphyGif({ id, width, height, onMediaLoad }: GiphyGifProps) {
  const [failed, setFailed] = useState(false);
  const box = fitSize(storedSize(width, height));
  return (
    <span className="my-1 flex max-w-full flex-col gap-1" style={{ width: box.width }} data-testid="giphy-gif">
      <span
        className="flex max-w-full items-center justify-center overflow-hidden rounded-md bg-muted text-xs text-muted-foreground"
        style={{ width: box.width, aspectRatio: `${box.width} / ${box.height}` }}
      >
        {failed ? (
          'GIF unavailable'
        ) : (
          <img
            src={giphyFileURL(id)}
            alt="GIF"
            width={box.width}
            height={box.height}
            className="h-full w-full object-contain"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={onMediaLoad}
            onError={() => setFailed(true)}
          />
        )}
      </span>
      <a
        href={giphyPageURL(id)}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        Powered by GIPHY
      </a>
    </span>
  );
}
