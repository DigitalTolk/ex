import type { GifSize } from '@/lib/gif-size';

// GifBox is the room a GIF's file takes at this width — the shape and
// corners ohmagif's GifFromId draws it in — held while the GIF is on its way
// (busy) or in its place when it can't be shown.
export function GifBox({ size, width, unavailable }: { size: GifSize; width: number; unavailable: boolean }) {
  return (
    <span
      className="flex max-w-full items-center justify-center overflow-hidden rounded-md bg-muted text-xs text-muted-foreground"
      style={{ width, aspectRatio: `${size.width} / ${size.height}` }}
      data-testid="gif-embed-box"
      aria-busy={unavailable ? undefined : true}
    >
      {unavailable ? 'GIF unavailable' : null}
    </span>
  );
}
