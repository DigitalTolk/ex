import { MonitorCog } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useUpdateWorkspaceSettings, useWorkspaceSettings } from '@/hooks/useSettings';

// RunnersInAppCard is the workspace switch for the AI hub's Runners tab —
// off until an admin turns it on. It saves the whole settings object (the
// endpoint replaces it), carrying the other values over unchanged.
export function RunnersInAppCard() {
  const { data } = useWorkspaceSettings();
  const update = useUpdateWorkspaceSettings();

  return (
    <section className="space-y-3 rounded-lg border bg-card p-5" data-testid="runners-in-app-card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-base font-semibold">
            <MonitorCog className="h-4 w-4" aria-hidden="true" />
            <Label htmlFor="runners-in-app" className="text-base font-semibold">
              Runners in the app
            </Label>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Adds a Runners tab under Agents. There people install, connect and start ex-runner — in one click in the
            desktop app — and see which of their computers are online. While it's off, they set up ex-runner from the
            command line, from Runners in their account menu.
          </p>
        </div>
        {data ? (
          <Switch
            id="runners-in-app"
            checked={data.runnersInApp === true}
            disabled={update.isPending}
            onCheckedChange={(next) =>
              update.mutate({
                maxUploadBytes: data.maxUploadBytes,
                allowedExtensions: data.allowedExtensions,
                giphyAPIKey: data.giphyAPIKey,
                runnersInApp: next,
              })
            }
            data-testid="runners-in-app-switch"
          />
        ) : (
          <Skeleton className="h-5 w-8 rounded-full" />
        )}
      </div>
      {update.error && (
        <p className="text-sm text-destructive" role="alert">
          Couldn't save: {update.error.message}
        </p>
      )}
    </section>
  );
}
