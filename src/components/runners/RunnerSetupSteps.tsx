import { CopyButton } from '@/components/ui/copy-button';

export const EX_RUNNER_README = 'https://github.com/DigitalTolk/ex-runners#install';
export const EX_RUNNER_RELEASES = 'https://github.com/DigitalTolk/ex-runners/releases/latest';

function Command({ cmd }: { cmd: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
      <code className="min-w-0 truncate font-mono text-sm">{cmd}</code>
      <CopyButton value={cmd} label={`Copy "${cmd}"`} size="icon" variant="ghost" />
    </div>
  );
}

// RunnerSetupSteps is the command-line way to connect a computer: Homebrew
// on macOS and Linux, a download everywhere else. `compact` is the short
// form the account menu's dialog shows.
export function RunnerSetupSteps({ compact = false }: { compact?: boolean }) {
  const login = `ex-runner login ${window.location.origin}`;
  if (compact) {
    return (
      <div className="space-y-2 text-sm">
        <p>
          To connect a computer,{' '}
          <a className="underline" href={EX_RUNNER_README} target="_blank" rel="noreferrer">
            install ex-runner
          </a>{' '}
          on it, then run:
        </p>
        <Command cmd={login} />
        <Command cmd="ex-runner start" />
      </div>
    );
  }
  const steps = [
    { title: 'Install ex-runner', cmd: 'brew install digitaltolk/tools/ex-runner' },
    { title: 'Connect it to your account — approve in the browser tab that opens', cmd: login },
    { title: 'Start it in the background — it comes back after a restart', cmd: 'brew services start ex-runner' },
  ];
  return (
    <div className="space-y-4" data-testid="runner-setup-steps">
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={s.cmd} className="flex gap-3">
            <span
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="text-sm">{s.title}</p>
              <Command cmd={s.cmd} />
            </div>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        No Homebrew, or on Windows?{' '}
        <a className="underline" href={EX_RUNNER_RELEASES} target="_blank" rel="noreferrer">
          Download ex-runner
        </a>
        , then run the login command above and <code className="font-mono">ex-runner start</code>.
      </p>
    </div>
  );
}
