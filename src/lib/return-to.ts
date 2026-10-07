// Where to land after signing in, for a page that sent a signed-out visitor
// to /login on purpose (today: /runner/connect, opened by `ex-runner login`).
// sessionStorage, so it survives the OIDC round trip through the identity
// provider in the same tab and dies with the tab; stamped with a time, so a
// sign-in long after the visitor wandered off still lands on #general.
//
// Ordinary sign-ins never write it, so they keep landing on #general.

const KEY = 'ex:return-to';
// Matches ex-runner's own login timeout: past it, the page being returned to
// is waiting on a terminal that already gave up.
export const RETURN_TO_TTL_MS = 10 * 60 * 1000;

// isSafeReturnPath admits only same-origin app paths. `//host` and `/\host`
// are protocol-relative to browsers (an open redirect), and returning to a
// sign-in screen would loop.
export function isSafeReturnPath(path: string): boolean {
  return (
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.startsWith('/\\') &&
    !path.startsWith('/login') &&
    !path.startsWith('/oidc/')
  );
}

export function rememberReturnTo(path: string, now: number = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ path, at: now }));
  } catch {
    // Storage blocked (private mode, quota): the visitor lands on #general.
  }
}

// takeReturnTo reads and clears the remembered path — one sign-in, one
// return — falling back when there is none, it's stale, or it's unsafe.
export function takeReturnTo(fallback: string, now: number = Date.now()): string {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  try {
    const saved = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (
      typeof saved.path === 'string' &&
      typeof saved.at === 'number' &&
      now - saved.at < RETURN_TO_TTL_MS &&
      isSafeReturnPath(saved.path)
    ) {
      return saved.path;
    }
  } catch {
    // Not ours or corrupted — ignore it.
  }
  return fallback;
}
