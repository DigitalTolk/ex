// isSafeUrl reports whether a URL is safe to use as a link href. It mirrors the
// Go authority (internal/service/markdown.go `isSafeURL`): absolute URLs are
// allowed only for http/https/mailto; any other explicit scheme (javascript:,
// data:, vbscript:, file: …) is rejected as a script-injection vector. Relative
// references (path, query, fragment, scheme-relative) carry no scheme and pass
// — unless they land on the server's sign-in routes (see isAuthRoute).
//
// The backend already strips unsafe link hrefs from the rendered HAST, so this
// is defense-in-depth for any render path that doesn't go through that authority
// (optimistic echoes, previews, future clients).
export function isSafeUrl(raw: string | undefined): boolean {
  return hasSafeScheme(raw) && !isAuthRoute(raw);
}

// Browsers strip ASCII control characters and spaces (tab, newline, CR, NUL,
// …) from a URL before navigating, so "java\tscript:alert(1)" would still
// execute. Strip them first so a check sees what the browser will act on.
function stripControl(raw: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  return (raw ?? '').replace(/[\x00-\x20\x7f]/g, '');
}

function hasSafeScheme(raw: string | undefined): boolean {
  const s = stripControl(raw);
  if (s === '') return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // A '/', '?' or '#' before any ':' → no scheme → relative reference → safe.
    if (c === '/' || c === '?' || c === '#') return true;
    if (c === ':') {
      const scheme = s.slice(0, i).toLowerCase();
      return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
    }
    // Valid scheme byte per RFC 3986: ALPHA / DIGIT / "+" / "-" / ".". Anything
    // else before a ':' means it isn't a scheme — treat as relative.
    if (!/[a-zA-Z0-9+.-]/.test(c)) return true;
  }
  // No ':' at all → relative reference → safe.
  return true;
}

// isAuthRoute reports whether a link lands on this app's own /auth/* routes —
// the sign-in endpoints (OIDC login and callback, the desktop sign-in
// hand-off, logout). User content must never link there: a click would run
// someone else's login or hand-off code in the viewer's browser (and the
// desktop shell keeps links to the chat host inside the app). Judged the way the server routes it: after
// the browser's own URL resolution (dot segments, backslashes) and one round
// of percent-decoding, case-insensitively.
export function isAuthRoute(raw: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(stripControl(raw), window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape: judge the path as written.
  }
  path = path.toLowerCase();
  return path === '/auth' || path.startsWith('/auth/');
}

// externalHref is the gate for every data-driven link that opens outside the
// app (target=_blank — and, in the desktop shell, the OS's handler for the
// URL): `raw` when it is an absolute http(s) URL, undefined otherwise. Other
// schemes (smb:, ms-msdt:, file:, javascript: …) would hand the click to
// whatever the operating system registered for them.
export function externalHref(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return isAuthRoute(raw) ? undefined : raw;
}
