import { DEFAULT_MEDIA_URL, OhmagifFetch } from '@ohmagif/js';

// The parts of the ohmagif integration that need @ohmagif/js itself. Only
// the lazily loaded GifFile and GifGrid import this module, so the library
// stays out of the bundle the app starts with.

// ohmagifClient is the API client for a key ohmagifKey accepted. The fetch
// is looked up on every request rather than kept from when the client was
// made, so a test's stub of it is the one used.
export function ohmagifClient(apiKey: string): OhmagifFetch {
  return new OhmagifFetch({ apiKey, fetch: (input, init) => globalThis.fetch(input, init) });
}

// Where a message's GIF files come from: ohmagif's own. Named here so a
// browser test can serve them itself instead of reaching ohmagif.
export const OHMAGIF_MEDIA_URL = DEFAULT_MEDIA_URL;
