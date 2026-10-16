import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { desktopRunner } from '@/lib/desktop-runner';

// RunnerLogDialog shows what ex-runner printed while the app ran it: the
// first place to look when an agent doesn't answer.
export function RunnerLogDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" mobileCloseLabel="Close">
        <DialogHeader>
          <DialogTitle>ex-runner log</DialogTitle>
          <DialogDescription>What ex-runner printed on this computer since ex started it.</DialogDescription>
        </DialogHeader>
        {open && <LogBody />}
      </DialogContent>
    </Dialog>
  );
}

function LogBody() {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    desktopRunner.readLog().then(
      (l) => {
        if (!live) return;
        setLines(l);
        setError(null);
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not read the log.');
      },
    );
    return () => {
      live = false;
    };
  }, [nonce]);

  return (
    <div className="space-y-3">
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {lines && lines.length === 0 && <p className="text-sm text-muted-foreground">Nothing yet — start ex-runner first.</p>}
      {lines && lines.length > 0 && (
        <pre
          className="max-h-[60dvh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all"
          data-testid="runner-log"
        >
          {lines.join('\n')}
        </pre>
      )}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => setNonce((n) => n + 1)}>
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </div>
    </div>
  );
}
