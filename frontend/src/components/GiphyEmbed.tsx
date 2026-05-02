import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { GiphyFetch } from '@giphy/js-fetch-api';
import type IGif from '@giphy/js-types/dist/gif';
import { useWorkspaceSettings } from '@/hooks/useSettings';

interface GiphyEmbedProps {
  id: string;
  apiKey?: string;
  width?: number;
  height?: number;
}

type GiphyMedia =
  | { kind: 'video'; url: string; title: string; giphyURL: string; width: number; height: number }
  | { kind: 'image'; url: string; title: string; giphyURL: string; width: number; height: number };

const FALLBACK_MEDIA_WIDTH = 320;
const FALLBACK_MEDIA_HEIGHT = 240;
const MAX_MEDIA_WIDTH = 420;
const MAX_MEDIA_HEIGHT = 320;
const GIPHY_MEMORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type GiphyCacheEntry = {
  expiresAt: number;
  media?: GiphyMedia;
  promise?: Promise<GiphyMedia>;
};

const giphyMemoryCache = new Map<string, GiphyCacheEntry>();

function normalizedDimensions(width?: number, height?: number) {
  const nativeWidth = width && width > 0 ? width : FALLBACK_MEDIA_WIDTH;
  const nativeHeight = height && height > 0 ? height : FALLBACK_MEDIA_HEIGHT;
  const scale = Math.min(1, MAX_MEDIA_WIDTH / nativeWidth, MAX_MEDIA_HEIGHT / nativeHeight);
  return {
    width: Math.round(nativeWidth * scale),
    height: Math.round(nativeHeight * scale),
  };
}

function GiphyFrame({
  children,
  giphyURL,
  width,
  height,
}: {
  children: ReactNode;
  giphyURL: string;
  width: number;
  height: number;
}) {
  const box = normalizedDimensions(width, height);
  return (
    <span
      className="my-1 inline-flex max-w-full flex-col gap-1 align-top"
      data-testid="giphy-embed"
      style={{ width: box.width }}
    >
      <span
        className="inline-flex max-w-full overflow-hidden rounded-md"
        style={{ width: box.width, height: box.height }}
      >
        {children}
      </span>
      <a
        href={giphyURL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        Powered by GIPHY
      </a>
    </span>
  );
}

function pickRendition(gif: IGif): GiphyMedia {
  const original = gif.images.original;
  const giphyURL = gif.url || 'https://giphy.com';
  if (gif.is_sticker && original.webp) {
    return {
      kind: 'image',
      url: original.webp,
      title: gif.title || 'GIPHY sticker',
      giphyURL,
      width: original.width,
      height: original.height,
    };
  }

  const originalMp4 = gif.images.original_mp4;
  const mp4URL = originalMp4?.mp4 || original.mp4 || gif.images.looping?.mp4;
  if (mp4URL) {
    return {
      kind: 'video',
      url: mp4URL,
      title: gif.title || 'GIPHY GIF',
      giphyURL,
      width: originalMp4?.width || original.width,
      height: originalMp4?.height || original.height,
    };
  }

  return {
    kind: 'image',
    url: original.url,
    title: gif.title || 'GIPHY GIF',
    giphyURL,
    width: original.width,
    height: original.height,
  };
}

function readCachedGiphyMedia(id: string): GiphyMedia | null {
  const entry = giphyMemoryCache.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    giphyMemoryCache.delete(id);
    return null;
  }
  return entry.media ?? null;
}

function fetchGiphyMedia(gf: GiphyFetch, id: string): Promise<GiphyMedia> {
  const cached = giphyMemoryCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.media) return Promise.resolve(cached.media);
    if (cached.promise) return cached.promise;
  }

  const promise = gf.gif(id).then((res) => {
    const media = pickRendition(res.data);
    giphyMemoryCache.set(id, {
      media,
      expiresAt: Date.now() + GIPHY_MEMORY_CACHE_TTL_MS,
    });
    return media;
  });

  giphyMemoryCache.set(id, {
    promise,
    expiresAt: Date.now() + GIPHY_MEMORY_CACHE_TTL_MS,
  });

  promise.catch(() => {
    const entry = giphyMemoryCache.get(id);
    if (entry?.promise === promise) giphyMemoryCache.delete(id);
  });

  return promise;
}

function Placeholder({
  children,
  width,
  height,
}: {
  children: string;
  width?: number;
  height?: number;
}) {
  const box = width && height ? normalizedDimensions(width, height) : null;
  return (
    <span
      className="my-1 inline-flex items-center rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
      style={box ? { width: box.width, height: box.height } : undefined}
    >
      {children}
    </span>
  );
}

export function GiphyEmbed({ id, apiKey, width, height }: GiphyEmbedProps) {
  if (apiKey !== undefined) {
    return <GiphyEmbedMedia id={id} apiKey={apiKey} width={width} height={height} />;
  }
  return <GiphyEmbedFromSettings id={id} width={width} height={height} />;
}

function GiphyEmbedFromSettings({
  id,
  width,
  height,
}: {
  id: string;
  width?: number;
  height?: number;
}) {
  const { data: settings, isLoading } = useWorkspaceSettings();
  if (!settings && isLoading) {
    return <Placeholder width={width} height={height}>Loading GIPHY...</Placeholder>;
  }
  return <GiphyEmbedMedia id={id} apiKey={settings?.giphyAPIKey ?? ''} width={width} height={height} />;
}

function GiphyEmbedMedia({ id, apiKey, width, height }: GiphyEmbedProps & { apiKey: string }) {
  const trimmedKey = apiKey.trim();
  const gf = useMemo(() => (trimmedKey ? new GiphyFetch(trimmedKey) : null), [trimmedKey]);
  const requestKey = `${trimmedKey}:${id}`;
  const [result, setResult] = useState<{
    requestKey: string;
    media: GiphyMedia | null;
    failed: boolean;
  }>(() => ({
    requestKey,
    media: readCachedGiphyMedia(id),
    failed: false,
  }));

  useEffect(() => {
    if (!gf || !id) return;
    let alive = true;
    const cached = readCachedGiphyMedia(id);
    if (cached) {
      queueMicrotask(() => {
        if (alive) setResult({ requestKey, media: cached, failed: false });
      });
      return () => {
        alive = false;
      };
    }
    fetchGiphyMedia(gf, id)
      .then((media) => {
        if (alive) setResult({ requestKey, media, failed: false });
      })
      .catch(() => {
        if (alive) setResult({ requestKey, media: null, failed: true });
      });
    return () => {
      alive = false;
    };
  }, [gf, id, requestKey]);

  const media = result.requestKey === requestKey ? result.media : null;
  const failed = result.requestKey === requestKey && result.failed;
  if (!trimmedKey) return <Placeholder width={width} height={height}>GIPHY unavailable</Placeholder>;
  if (failed) return <Placeholder width={width} height={height}>GIPHY unavailable</Placeholder>;
  if (!media) return <Placeholder width={width} height={height}>Loading GIPHY...</Placeholder>;

  if (media.kind === 'video') {
    const box = normalizedDimensions(media.width, media.height);
    return (
      <GiphyFrame giphyURL={media.giphyURL} width={media.width} height={media.height}>
        <video
          src={media.url}
          aria-label={media.title}
          title={media.title}
          width={media.width}
          height={media.height}
          className="rounded-md"
          style={{ width: box.width, height: box.height }}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
        />
      </GiphyFrame>
    );
  }

  const box = normalizedDimensions(media.width, media.height);
  return (
    <GiphyFrame giphyURL={media.giphyURL} width={media.width} height={media.height}>
      <img
        src={media.url}
        alt={media.title}
        width={media.width}
        height={media.height}
        className="rounded-md"
        style={{ width: box.width, height: box.height }}
        loading="lazy"
      />
    </GiphyFrame>
  );
}
