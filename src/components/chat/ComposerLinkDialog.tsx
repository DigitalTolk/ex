import { memo } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isHttpUrl } from '@/lib/utils';
import type { LinkDialogState } from './useLinkDialog';

// The composer toolbar's Insert-link dialog (state: useLinkDialog). Memoized,
// so it re-renders with its own fields, not with every keystroke.
export const ComposerLinkDialog = memo(function ComposerLinkDialog({
  dialog,
  isMobile,
}: {
  dialog: LinkDialogState;
  isMobile: boolean;
}) {
  return (
    <Dialog open={dialog.open} onOpenChange={dialog.setOpen}>
      {/* Mobile: Cancel/Insert live in the top-right header — the URL field
          autofocuses, so a bottom footer sat behind the keyboard. */}
      <DialogContent
        aria-label="Insert link"
        mobileCloseLabel="Cancel"
        mobileAction={
          isMobile
            ? { label: 'Insert', onClick: dialog.submit, disabled: !isHttpUrl(dialog.url.trim()) }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>Insert link</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            dialog.submit();
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-text">Text</Label>
            <Input
              id="link-text"
              value={dialog.text}
              onChange={(e) => dialog.setText(e.target.value)}
              placeholder="Link text"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-url">URL</Label>
            <Input
              id="link-url"
              value={dialog.url}
              onChange={(e) => dialog.setUrl(e.target.value)}
              placeholder="https://example.com"
              autoFocus
              required
              type="url"
            />
          </div>
          {!isMobile && (
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => dialog.setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!isHttpUrl(dialog.url.trim())}>
                Insert
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
});
