import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CustomEmojiDescription, CustomEmojiManager } from './CustomEmojiManager';

interface CustomEmojiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Custom emojis as a pop-up over the current view (opened from the account
// menu), so managing emojis doesn't navigate away from the conversation. It's
// wide and tall enough for the multi-column grid; the list scrolls inside.
export function CustomEmojiDialog({ open, onOpenChange }: CustomEmojiDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="3xl"
        mobileCloseLabel="Done"
        finalFocus={false}
        // Start in the shortcode field (not the image picker) so you can type
        // right away; guests have no form, so fall back to the dialog itself.
        initialFocus={() => document.getElementById('emoji-name') ?? true}
        className="h-[min(720px,calc(100dvh-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 mobile:h-auto mobile:overflow-hidden mobile:p-0"
        data-testid="custom-emoji-dialog"
      >
        <DialogHeader className="border-b px-6 pt-5 pb-4 mobile:px-4 mobile:pt-[calc(env(safe-area-inset-top)+0.75rem)]">
          <DialogTitle className="text-lg font-semibold">Custom emojis</DialogTitle>
          <DialogDescription>
            <CustomEmojiDescription />
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-6 py-5 mobile:px-4 mobile:pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          {/* Remount per open so the upload form starts empty each time. */}
          {open && <CustomEmojiManager />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
