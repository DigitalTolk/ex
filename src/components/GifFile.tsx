import { useState } from 'react';
import { GifFromId } from '@ohmagif/js/react';
import { GifBox } from '@/components/GifBox';
import { OHMAGIF_MEDIA_URL } from '@/lib/ohmagif-client';
import type { GifSize } from '@/lib/gif-size';

interface GifFileProps {
  id: string;
  size: GifSize;
  width: number;
  onMediaLoad?: () => void;
}

// GifFile draws a GIF from its id and size alone (ohmagif's GifFromId): the
// whole file from its lasting address, the credit strip along its bottom
// showing, linking to the GIF's page. The lazily loaded half of GifEmbed: it
// is what brings in @ohmagif/js. A GIF that was taken down keeps its room,
// unavailable.
export default function GifFile({ id, size, width, onMediaLoad }: GifFileProps) {
  const [failed, setFailed] = useState(false);
  if (failed) return <GifBox size={size} width={width} unavailable />;
  return (
    <GifFromId
      id={id}
      size={size}
      width={width}
      mediaURL={OHMAGIF_MEDIA_URL}
      onLoad={onMediaLoad}
      onError={() => setFailed(true)}
    />
  );
}
