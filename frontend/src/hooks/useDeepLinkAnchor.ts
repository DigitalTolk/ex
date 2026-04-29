import { useLocation, useSearchParams } from 'react-router-dom';

// useDeepLinkAnchor resolves the current location into a pair of
// optional anchors: one for the main message list (`mainAnchor`) and
// one for an in-thread reply (`threadAnchor`).
//
// URL format:
//   /channel/eng#msg-X            → mainAnchor=X, threadAnchor=undefined
//   /channel/eng?thread=R#msg-Y   → mainAnchor=R (root, in main list),
//                                    threadAnchor=Y (reply, in thread panel)
//
// Without the thread param, the hash IS the main-list anchor — which
// is what a normal "jump to message" link encodes. With ?thread=R, the
// caller is deep-linking into a reply: the thread root R must show up
// (highlighted) in the main list, and the reply Y must show up
// (highlighted) inside the thread panel.
//
// The `parentKey` arg is unused now — kept for call-site stability.
export function useDeepLinkAnchor(_parentKey: string | undefined): {
  mainAnchor?: string;
  threadAnchor?: string;
  // Convenience: the raw `?thread=` value, so the caller can decide
  // whether to auto-open the thread panel without re-parsing the URL.
  threadParam?: string;
  // Per-navigation token. Changes on EVERY navigation, including
  // re-clicking a Link that points at the current URL. Consumers use
  // it as part of their dedup key so re-clicks re-fire the anchor
  // scroll/highlight even though the anchor itself didn't change.
  navKey?: string;
} {
  const location = useLocation();
  const { hash, key } = location;
  const [searchParams] = useSearchParams();
  const hashMsg = parseHash(hash);
  const threadParam = searchParams.get('thread') || undefined;
  if (threadParam) {
    return {
      mainAnchor: threadParam,
      threadAnchor: hashMsg && hashMsg !== threadParam ? hashMsg : undefined,
      threadParam,
      navKey: key,
    };
  }
  if (hashMsg) {
    return { mainAnchor: hashMsg, navKey: key };
  }
  return {};
}

function parseHash(hash: string): string | undefined {
  if (!hash || !hash.startsWith('#msg-')) return undefined;
  return hash.slice('#msg-'.length) || undefined;
}
