// GIFs come from ohmagif.com. The composer's picker searches it with the
// workspace's key, and a message keeps only the GIF's id and the size of
// its file (`![GIF](ohmagif:<id> =WxH)`). A GIF's files never change address
// while it is up, so a message shows its GIF from them directly: no key, no
// request to the API.
//
// @ohmagif/js loads only once a GIF is shown or the picker opens (GifFile,
// GifGrid). What has to be known before then lives here, without it:
// whether there is a key and whether an id is one. ohmagif.test checks each
// against the library.

const API_KEY_RE = /^omg_[0-9A-Za-z]{32}$/;
const GIF_ID_RE = /^[0-9A-Za-z]{10}$/;

// ohmagifKey is the workspace's ohmagif key, trimmed, or null when there is
// none or it is not one (the library's isApiKey; its client refuses others).
export function ohmagifKey(apiKey: string | undefined): string | null {
  const key = apiKey?.trim() ?? '';
  return API_KEY_RE.test(key) ? key : null;
}

// isOhmagifId is the library's isGifId: 10 letters or digits.
export function isOhmagifId(id: string): boolean {
  return GIF_ID_RE.test(id);
}
