// AUTH_INVALID_EVENT fires when the session is terminally invalid (a refresh
// failed mid-session). AuthContext listens and logs the user out + routes to
// /login. Kept in its own tiny module (not api.ts) so the many tests that mock
// @/lib/api don't have to re-export it, and so api.ts ↔ AuthContext stay
// decoupled.
export const AUTH_INVALID_EVENT = 'ex:auth-invalid';

export function notifyAuthInvalid() {
  /* istanbul ignore else -- this browser-only app always has window */
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_INVALID_EVENT));
  }
}
