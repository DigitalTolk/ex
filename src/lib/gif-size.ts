// The size a GIF in a message is shown at: the size the message kept,
// fitted into 420 by 320 and never enlarged. Known before anything loads, so
// the message list measures the row right the first time.

export interface GifSize {
  width: number;
  height: number;
}

// A message that kept no size (or a size no GIF has) shows its GIF in this
// shape.
const FALLBACK_SIZE: GifSize = { width: 320, height: 240 };
const MAX_WIDTH = 420;
const MAX_HEIGHT = 320;

function pixels(n: number | undefined): n is number {
  return Number.isInteger(n) && (n as number) > 0;
}

// storedSize is the size a message kept with the GIF, in whole pixels, or
// the fallback shape when it kept none.
export function storedSize(width?: number, height?: number): GifSize {
  return pixels(width) && pixels(height) ? { width, height } : FALLBACK_SIZE;
}

// fitSize is the size fitted into 420 by 320, never enlarged.
export function fitSize(size: GifSize): GifSize {
  const scale = Math.min(1, MAX_WIDTH / size.width, MAX_HEIGHT / size.height);
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}
