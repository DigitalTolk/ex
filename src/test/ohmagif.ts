import { vi, type MockInstance } from 'vitest';

// Test doubles for ohmagif.com, at the network edge: the API's own JSON
// (what @ohmagif/js parses and checks), served by a stub of fetch, so the
// real client and Grid run in tests. A message's GIF needs none of this: its
// files come from its id (browser tests serve them from
// src/test/fixtures/ohmagif).

export const TEST_OHMAGIF_KEY = 'omg_0123456789abcdefABCDEF0123456789';

// The credit strip ohmagif draws under every file's frame.
const STRIP = 24;
const TINY_WIDTH = 320;

interface GifOptions {
  title?: string;
  description?: string;
  // The frame (the file without its credit strip). Pick a shape whose
  // tiny.avif frame is a whole number of pixels (4:3, 16:9 at 480 wide…),
  // and frameSize(gif) is exactly this.
  width?: number;
  height?: number;
  handle?: string;
}

// apiGif is one GIF as the API answers it. Its files sit on the page's own
// origin, under a path nothing serves: a browser test never reaches out to
// ohmagif's CDN, and a picture that does not load leaves the card's box as
// it is.
export function apiGif(id: string, options: GifOptions = {}): Record<string, unknown> {
  const width = options.width ?? 400;
  const height = options.height ?? 300;
  const tinyFrame = Math.round((TINY_WIDTH * height) / width);
  const files = `${window.location.origin}/__ohmagif__/${id}`;
  const handle = options.handle ?? 'maker';
  return {
    id,
    title: options.title ?? `GIF ${id}`,
    description: options.description ?? '',
    url: `https://ohmagif.com/g/${id}`,
    embed_url: `https://ohmagif.com/embed/${id}`,
    width,
    height: height + STRIP,
    created: '2026-11-26T12:00:00Z',
    duration: 1,
    rating: 'g',
    tags: [],
    reaction: null,
    creator: { handle, name: handle, url: `https://ohmagif.com/@${handle}` },
    files: {
      full: { url: `${files}/full.avif`, type: 'image/avif', width, height: height + STRIP, bytes: 1 },
      tiny: { url: `${files}/tiny.avif`, type: 'image/avif', width: TINY_WIDTH, height: tinyFrame + STRIP, bytes: 1 },
      poster: { url: `${files}/poster.jpg`, type: 'image/jpeg', width, height: height + STRIP, bytes: 1 },
    },
  };
}

// apiList is a page of GIFs (trending, search) as the API answers it.
export function apiList(gifs: Record<string, unknown>[], options: { next?: number | null; total?: number } = {}) {
  return { results: gifs, next: options.next ?? null, total: options.total ?? gifs.length };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export type OhmagifAnswer = (url: URL, init?: RequestInit) => Response | Promise<Response>;

// stubOhmagif answers every request to ohmagif.com with `answer` and passes
// any other request through. Restore the returned spy when the test ends.
export function stubOhmagif(answer: OhmagifAnswer): MockInstance<typeof fetch> {
  const passThrough = globalThis.fetch.bind(globalThis);
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://ohmagif.com') return passThrough(input, init);
    return Promise.resolve(answer(url, init));
  });
}

// ohmagifRequests lists the API paths (with their queries) the stub was
// asked for, e.g. "/api/v1/trending?limit=12&offset=0&rating=pg".
export function ohmagifRequests(spy: MockInstance<typeof fetch>): string[] {
  return spy.mock.calls
    .map(([input]) => new URL(input instanceof Request ? input.url : String(input)))
    .filter((url) => url.origin === 'https://ohmagif.com')
    .map((url) => url.pathname + url.search);
}
