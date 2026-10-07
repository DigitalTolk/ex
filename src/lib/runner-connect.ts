// /runner/connect — the browser half of `ex-runner login`. ex-runner opens
// this page with the port it listens on (127.0.0.1 only), a state value, its
// PKCE challenge and the machine's name. Approving asks the server for a
// one-time code bound to that challenge and sends the browser back to the
// listener with it; ex-runner redeems the code with the verifier only it
// holds, so the runner token itself never passes through the browser.

export interface ConnectRequest {
  port: number;
  state: string;
  challenge: string;
  name: string;
}

const URL_SAFE = /^[A-Za-z0-9_-]{16,128}$/;
const NAME_MAX = 64;

// parseConnectRequest validates the query ex-runner put on the link. The
// port must be a real unprivileged port — it's the only part of the redirect
// target that comes from the URL; the host is always 127.0.0.1.
export function parseConnectRequest(params: URLSearchParams): ConnectRequest | null {
  const rawPort = params.get('port') ?? '';
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  const state = params.get('state') ?? '';
  const challenge = params.get('challenge') ?? '';
  if (!(port >= 1024 && port <= 65535) || !URL_SAFE.test(state) || !URL_SAFE.test(challenge)) return null;
  const name = (params.get('name') ?? '').trim().slice(0, NAME_MAX) || 'this computer';
  return { port, state, challenge, name };
}

// callbackUrl is where the browser goes once the user decides: back to the
// waiting ex-runner, with the one-time code or with a refusal.
export function callbackUrl(req: ConnectRequest, outcome: { code: string } | { error: string }): string {
  const q = new URLSearchParams({ ...outcome, state: req.state });
  return `http://127.0.0.1:${req.port}/callback?${q.toString()}`;
}

// leaveFor hands the tab to the local listener. A seam so tests can watch
// the redirect without jsdom attempting the navigation.
export const runnerConnectNav = {
  leaveFor(url: string): void {
    window.location.assign(url);
  },
};
