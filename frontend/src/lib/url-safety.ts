// isSafeUrl reports whether a URL is safe to use as a link href. It mirrors the
// Go authority (internal/service/markdown.go `isSafeURL`): absolute URLs are
// allowed only for http/https/mailto; any other explicit scheme (javascript:,
// data:, vbscript:, file: …) is rejected as a script-injection vector. Relative
// references (path, query, fragment, scheme-relative) carry no scheme and pass.
//
// The backend already strips unsafe link hrefs from the rendered HAST, so this
// is defense-in-depth for any render path that doesn't go through that authority
// (optimistic echoes, previews, future clients).
export function isSafeUrl(raw: string | undefined): boolean {
  const s = (raw ?? '').trim();
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
