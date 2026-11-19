import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatTallyTime } from '@/lib/block-text';
import type { ActionReceipt } from '@/stores/action-receipts';
import { SentPanel } from './SentPanel';

// SentDetailsDialog shows again what a person sent in a form, from the line
// under the card they opened it from.
export default function SentDetailsDialog({ details, at, onClose }: { details: NonNullable<ActionReceipt['details']>; at: number; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" mobileCloseLabel="Close" data-testid="sent-details-dialog">
        <DialogHeader className="gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {details.app} · sent {formatTallyTime(new Date(at).toISOString())}
          </span>
          <DialogTitle className="text-lg leading-snug font-semibold">{details.title}</DialogTitle>
          <DialogDescription className="sr-only">What you sent in this form</DialogDescription>
        </DialogHeader>
        <SentPanel app={details.app} notice={details.notice} answers={details.answers} />
        <DialogFooter className="mobile:hidden">
          <Button type="button" onClick={onClose} autoFocus>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
