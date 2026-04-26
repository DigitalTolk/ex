import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const REPO_URL = 'https://github.com/DigitalTolk/ex';

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="sr-only">About ex</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <img src="/logo.svg" alt="" className="h-16 w-16" />
          <p className="text-2xl font-semibold lowercase tracking-tight">ex</p>
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
