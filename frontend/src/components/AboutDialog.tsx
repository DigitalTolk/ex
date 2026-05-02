import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BUILD_DISPLAY_VERSION } from '@/hooks/useServerVersion';

const REPO_URL = 'https://github.com/DigitalTolk/ex';

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed?: () => void;
}

export function AboutDialog({ open, onOpenChange, onClosed }: AboutDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onClosed?.();
      }}
    >
      <DialogContent className="max-w-sm" finalFocus={false}>
        <DialogHeader>
          <DialogTitle className="sr-only">About ex</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <img src="/logo.svg" alt="" className="h-16 w-16" />
          <p className="text-2xl font-semibold lowercase tracking-tight">ex</p>
          <p className="text-xs text-muted-foreground">Version {BUILD_DISPLAY_VERSION}</p>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary underline-offset-2 hover:underline"
          >
            {REPO_URL.replace(/^https?:\/\//, '')}
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
