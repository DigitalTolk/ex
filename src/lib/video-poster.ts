// What a video shows before it plays: its size, and one of its frames,
// captured in the uploader's browser (the server can't decode video). The
// message list draws the frame as the video's thumbnail, at the video's size,
// instead of a file card.
export interface VideoPoster {
  width: number;
  height: number;
  poster: Blob;
}

// Where the frame is taken: a little past the start, since a video's very
// first frame is often black (a fade in). A shorter clip gives its middle.
const POSTER_AT_SECONDS = 0.5;
// The longest side of the frame sent; the server makes the thumbnails from it.
const POSTER_MAX_SIDE = 1280;
// Giving up: a video in a codec this browser lacks never loads.
export const POSTER_TIMEOUT_MS = 10_000;

// readVideoPoster loads a video file into a muted, unseen <video>, seeks into
// it, and draws that frame. Null when the browser can't decode it, the file
// has no picture (an audio-only MP4), or it doesn't load in time.
export function readVideoPoster(file: Blob): Promise<VideoPoster | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let finished = false;
    const finish = (poster: VideoPoster | null) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(poster);
    };
    const timer = window.setTimeout(() => finish(null), POSTER_TIMEOUT_MS);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('error', () => finish(null));
    video.addEventListener(
      'loadeddata',
      () => {
        // A clip with no known length (a live recording) reports Infinity.
        video.currentTime = Math.min(POSTER_AT_SECONDS, video.duration / 2);
      },
      { once: true },
    );
    video.addEventListener(
      'seeked',
      () => {
        const { videoWidth: width, videoHeight: height } = video;
        if (!width || !height) {
          finish(null);
          return;
        }
        const scale = Math.min(1, POSTER_MAX_SIDE / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (poster) =>
            /* v8 ignore next -- toBlob yields null only for a zero-size canvas or a missing encoder; this canvas is at least 1x1 and every browser encodes JPEG */
            /* istanbul ignore next -- toBlob yields null only for a zero-size canvas or a missing encoder; this canvas is at least 1x1 and every browser encodes JPEG */
            finish(poster ? { width, height, poster } : null),
          'image/jpeg',
          0.85,
        );
      },
      { once: true },
    );
    video.src = url;
    video.load();
  });
}
