import { lazy, Suspense } from 'react';
import { GifBox } from '@/components/GifBox';
import { fitSize, storedSize } from '@/lib/gif-size';
import { isOhmagifId } from '@/lib/ohmagif';

// The GIF's file needs @ohmagif/js to draw, which loads with the first GIF.
const GifFile = lazy(() => import('@/components/GifFile'));

interface GifEmbedProps {
  id: string;
  // The size of the GIF's file as the message kept it.
  width?: number;
  height?: number;
  onMediaLoad?: () => void;
}

// GifEmbed shows an `ohmagif:<id>` GIF in a message: its file, credit strip
// included, linking to the GIF's page. Until the library has loaded, or
// when the GIF can't be shown, a box of exactly the file's size holds its
// place, so the message list never moves.
export function GifEmbed({ id, width, height, onMediaLoad }: GifEmbedProps) {
  const size = storedSize(width, height);
  const shown = fitSize(size).width;
  return (
    <span className="my-1 block" data-testid="gif-embed">
      {isOhmagifId(id) ? (
        <Suspense fallback={<GifBox size={size} width={shown} unavailable={false} />}>
          <GifFile id={id} size={size} width={shown} onMediaLoad={onMediaLoad} />
        </Suspense>
      ) : (
        <GifBox size={size} width={shown} unavailable />
      )}
    </span>
  );
}
