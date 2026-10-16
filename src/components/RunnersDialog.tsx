import { Link } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RunnerList } from '@/components/runners/RunnerList';
import { RunnerSetupSteps } from '@/components/runners/RunnerSetupSteps';
import { useRunnerTokens } from '@/hooks/useRunnerTokens';
import { useWorkspaceSettings } from '@/hooks/useSettings';

interface RunnersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// RunnersDialog lists the computers connected with ex-runner — where the
// user's Claude Code and Codex agents run — and disconnects them. Bedrock
// agents run on the server and need none of this. When the workspace has
// the Runners tab turned on, it points there for the full setup.
export function RunnersDialog({ open, onOpenChange }: RunnersDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" mobileCloseLabel="Close">
        <DialogHeader>
          <DialogTitle>Runners</DialogTitle>
          <DialogDescription>
            Computers that run your Claude Code and Codex agents. Bedrock agents run on the server and need no runner.
          </DialogDescription>
        </DialogHeader>
        {open && <RunnersBody onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function RunnersBody({ onClose }: { onClose: () => void }) {
  const { data: runners, isLoading, error } = useRunnerTokens();
  const { data: settings } = useWorkspaceSettings();

  return (
    <div className="space-y-4">
      <RunnerList runners={runners} isLoading={isLoading} error={error} />
      {settings?.runnersInApp ? (
        <p className="text-sm">
          Set up this computer or another one on the{' '}
          <Link className="underline" to="/runners" onClick={onClose} data-testid="runners-dialog-open-tab">
            Runners tab
          </Link>
          .
        </p>
      ) : (
        <RunnerSetupSteps compact />
      )}
    </div>
  );
}
