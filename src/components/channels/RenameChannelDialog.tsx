import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useRenameChannel } from '@/hooks/useChannels';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useAutoFocusTextInput } from '@/hooks/useHardwareKeyboard';
import { useChannelName } from '@/hooks/useChannelName';
import { ApiError } from '@/lib/api';
import type { Channel } from '@/types';
import { ChannelNameField } from './ChannelNameField';

interface RenameChannelDialogProps {
  channel: Channel;
  onOpenChange: (open: boolean) => void;
}

// Renames a channel. Mounted only while open, so each opening starts from the
// channel's current name. The channel's URL follows the new name; the open
// view moves along with it.
export function RenameChannelDialog({ channel, onOpenChange }: RenameChannelDialogProps) {
  const nameField = useChannelName({ initial: channel.name, channelId: channel.id });
  const { finalName, nameError } = nameField;
  const [submitError, setSubmitError] = useState('');
  const rename = useRenameChannel();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const autoFocusTextInput = useAutoFocusTextInput();

  const canSubmit = !!finalName && !nameError && finalName !== channel.name && !rename.isPending;

  function submit() {
    setSubmitError('');
    if (!canSubmit) return;
    const submitted = finalName;
    nameField.setName(submitted);
    rename.mutate(
      { channelId: channel.id, name: submitted },
      {
        onSuccess: (renamed) => {
          onOpenChange(false);
          navigate(`/channel/${renamed.slug}${location.search}${location.hash}`, { replace: true });
        },
        onError: (err: unknown) => {
          if (err instanceof ApiError && err.status === 409) {
            nameField.taken(submitted);
            return;
          }
          setSubmitError(err instanceof Error ? err.message : 'Failed to rename channel');
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        mobileCloseLabel="Cancel"
        mobileAction={
          isMobile
            ? { label: rename.isPending ? 'Saving...' : 'Save', onClick: submit, disabled: !canSubmit }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>Rename channel</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-4"
        >
          <ChannelNameField field={nameField} autoFocus={autoFocusTextInput} />
          <p
            data-testid="channel-rename-error"
            role={submitError ? 'alert' : undefined}
            className={`min-h-[1.25rem] text-sm ${submitError ? 'text-destructive' : ''}`}
          >
            {submitError || ' '}
          </p>
          {!isMobile && (
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {rename.isPending ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
