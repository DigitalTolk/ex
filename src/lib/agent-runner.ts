// Desktop agent-runner token handoff (plan-v2 §3). Inside the Electron shell
// the preload injects window.__EX_AGENT_RUNNER__; the SPA — which holds the
// interactive session — mints the runner-scoped token and hands it down. The
// shell never mints it itself: doing that through the refresh flow would
// rotate the refresh cookie in the shared jar and race this app into a
// logout.
import { apiFetch } from '@/lib/api';

interface RunnerTokenResponse {
  token: string;
  expiresAt: string;
}

let handedOff = false;

// provideRunnerToken mints and hands the runner token to the desktop shell.
// Once per app load is enough: the shell persists it (encrypted) and the
// next launch re-mints on the next load anyway. No-op outside the shell.
export async function provideRunnerToken(): Promise<void> {
  if (handedOff) return;
  const bridge = window.__EX_AGENT_RUNNER__;
  if (!bridge || typeof bridge.provideToken !== 'function') return;
  handedOff = true;
  try {
    const res = await apiFetch<RunnerTokenResponse>('/api/v1/agents/runner-token', {
      method: 'POST',
    });
    bridge.provideToken(res.token);
  } catch (err) {
    handedOff = false; // let a later call retry (e.g. after re-auth)
    console.warn('agent runner token handoff failed', err);
  }
}

// resetRunnerHandoff clears the once-latch (logout → login as someone else
// must re-mint for the new session).
export function resetRunnerHandoff(): void {
  handedOff = false;
}
