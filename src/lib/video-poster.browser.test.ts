import { afterEach, describe, expect, it, vi } from 'vitest';
import { POSTER_TIMEOUT_MS, readVideoPoster } from './video-poster';
import { CLIP_HEIGHT, CLIP_WIDTH, clipWebm } from '@/test/video-fixture';

// The colour at (x, y) of a JPEG blob.
async function pixel(blob: Blob, x: number, y: number) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
  return { r, g, b };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('readVideoPoster', () => {
  it('takes a frame from past the start, at the video\'s own size', async () => {
    const poster = await readVideoPoster(clipWebm());
    expect(poster).toMatchObject({ width: CLIP_WIDTH, height: CLIP_HEIGHT });
    expect(poster!.poster.type).toBe('image/jpeg');
    // The clip opens on black; the poster is the picture after it.
    const left = await pixel(poster!.poster, 10, 18);
    const right = await pixel(poster!.poster, 54, 18);
    expect(left.r).toBeGreaterThan(180);
    expect(left.b).toBeLessThan(80);
    expect(right.b).toBeGreaterThan(180);
    expect(right.r).toBeLessThan(80);
  });

  it('has none for a file the browser cannot decode', async () => {
    const junk = new File([new Uint8Array(512).fill(7)], 'broken.mp4', { type: 'video/mp4' });
    await expect(readVideoPoster(junk)).resolves.toBeNull();
  });

  it('has none for a video with no picture (an audio-only MP4)', async () => {
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(0);
    await expect(readVideoPoster(clipWebm())).resolves.toBeNull();
  });

  it('gives up on a video that does not load in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = readVideoPoster(clipWebm());
    vi.advanceTimersByTime(POSTER_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
  });

  it('answers once, whatever the video does after', async () => {
    const create = document.createElement.bind(document);
    let video: HTMLVideoElement | undefined;
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
      const el = create(tag, options);
      if (tag === 'video') video = el as HTMLVideoElement;
      return el;
    });
    const junk = new File([new Uint8Array(16)], 'broken.mp4', { type: 'video/mp4' });
    const pending = readVideoPoster(junk);
    video!.dispatchEvent(new Event('error'));
    video!.dispatchEvent(new Event('error'));
    await expect(pending).resolves.toBeNull();
  });
});
