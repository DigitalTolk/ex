import { useEffect, useRef, useState } from 'react';
import { desktopRunner, hasDesktopRunner, nextStep, type DesktopRunnerState } from '@/lib/desktop-runner';
import { useWorkspaceSettings } from '@/hooks/useSettings';

// useDesktopRunner follows the desktop app's ex-runner state: the first read
// plus every push. `available` is false in a browser; `state` stays null
// until the app answers (and if it never does, the card simply shows the
// command-line steps instead).
export function useDesktopRunner(): { available: boolean; state: DesktopRunnerState | null } {
  const [available] = useState(hasDesktopRunner);
  const [state, setState] = useState<DesktopRunnerState | null>(null);

  useEffect(() => {
    if (!available) return;
    let live = true;
    const unsubscribe = desktopRunner.subscribe((s) => {
      if (live) setState(s);
    });
    desktopRunner.getState().then(
      (s) => {
        if (live) setState(s);
      },
      () => {
        // An app that can't answer reads as "no desktop control" — the card
        // falls back to the command-line steps.
      },
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [available]);

  return { available, state };
}

// useDesktopRunnerAutostart starts ex-runner once per app launch when the
// person turned on "Start when ex opens" — and only while the workspace has
// Runners in the app turned on, the computer is connected to this server,
// and nothing is running yet. Mounted once, in the app shell.
export function useDesktopRunnerAutostart(): void {
  const { data: settings } = useWorkspaceSettings();
  const { available, state } = useDesktopRunner();
  const tried = useRef(false);
  const enabled = settings?.runnersInApp === true;

  useEffect(() => {
    if (tried.current || !available || !enabled || !state || !state.supported || !state.autoStart) return;
    // The Runners list isn't loaded here, so "is this install mine" is left
    // to the server: a foreign or revoked token just fails to sign in.
    if (nextStep(state, window.location.origin, null).step !== 'start' || state.busy) return;
    tried.current = true;
    desktopRunner.start().catch(() => {
      // The card shows the app's own error state; nothing to add here.
    });
  }, [available, enabled, state]);
}
