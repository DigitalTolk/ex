// GIFs picked from GIPHY before ohmagif replaced it: the message kept
// GIPHY's id (and mostly its size), and GIPHY serves every GIF's files at
// addresses built from that id, with no key — no SDK, no API call. The GIF
// file itself, which shows anywhere an image does.

// A GIPHY id: letters, digits, '-' and '_' — nothing that could reshape an
// address built from it.
const GIPHY_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isGiphyId(id: string): boolean {
  return GIPHY_ID_RE.test(id);
}

export function giphyFileURL(id: string): string {
  return `https://i.giphy.com/${id}.gif`;
}

// The GIF's page on GIPHY, which the attribution GIPHY asks for links to.
export function giphyPageURL(id: string): string {
  return `https://giphy.com/gifs/${id}`;
}
