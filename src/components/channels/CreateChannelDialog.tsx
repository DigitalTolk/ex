import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useCreateChannel } from '@/hooks/useChannels';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useAutoFocusTextInput } from '@/hooks/useHardwareKeyboard';
import { ApiError } from '@/lib/api';
import {
  MAX_CHANNEL_DESCRIPTION_LEN,
  countCodepoints,
  validateChannelDescription,
} from '@/lib/limits';
import { ChannelNameField } from './ChannelNameField';
import { useChannelName } from '@/hooks/useChannelName';

interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateChannelDialog({
  open,
  onOpenChange,
}: CreateChannelDialogProps) {
  const nameField = useChannelName();
  const { finalName, nameError } = nameField;
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const createChannel = useCreateChannel();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const autoFocusTextInput = useAutoFocusTextInput();

  const descriptionError = useMemo(
    () => validateChannelDescription(description),
    [description],
  );

  const descLen = countCodepoints(description);

  function reset() {
    nameField.reset();
    setDescription('');
    setIsPrivate(false);
    setSubmitError('');
  }

  // Shared by the desktop form submit and the mobile top-bar Create button
  // (which lives outside the <form>, in the dialog's mobile header).
  function submit() {
    setSubmitError('');
    if (!finalName || nameError || descriptionError) return;

    const submitted = finalName;
    nameField.setName(submitted);
    createChannel.mutate(
      {
        name: submitted,
        description: description.trim() || undefined,
        type: isPrivate ? 'private' : 'public',
      },
      {
        onSuccess: (channel) => {
          reset();
          onOpenChange(false);
          navigate(`/channel/${channel.slug}`);
        },
        onError: (err: unknown) => {
          if (err instanceof ApiError && err.status === 409) {
            nameField.taken(submitted);
            return;
          }
          setSubmitError(err instanceof Error ? err.message : 'Failed to create channel');
        },
      },
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  const canSubmit =
    !!finalName &&
    !nameError &&
    !descriptionError &&
    !createChannel.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        mobileCloseLabel="Cancel"
        mobileAction={
          isMobile
            ? {
                label: createChannel.isPending ? 'Creating...' : 'Create',
                onClick: submit,
                disabled: !canSubmit,
              }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <ChannelNameField field={nameField} autoFocus={autoFocusTextInput} />

          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="channel-desc">
                Description{' '}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <span
                data-testid="channel-desc-counter"
                className={`text-xs tabular-nums ${
                  descLen > MAX_CHANNEL_DESCRIPTION_LEN ? 'text-destructive' : 'text-muted-foreground'
                }`}
              >
                {descLen}/{MAX_CHANNEL_DESCRIPTION_LEN}
              </span>
            </div>
            <Input
              id="channel-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-invalid={descriptionError ? 'true' : 'false'}
              aria-describedby="channel-desc-help"
            />
            <p
              id="channel-desc-help"
              data-testid="channel-desc-help"
              className={`min-h-[1.25rem] text-xs ${
                descriptionError ? 'text-destructive' : 'text-muted-foreground'
              }`}
            >
              {descriptionError ?? ' '}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="channel-private">Make private</Label>
            <Switch
              id="channel-private"
              checked={isPrivate}
              onCheckedChange={setIsPrivate}
            />
          </div>

          {/* Submit-error slot, also reserved so the dialog doesn't
              shift when an error message fades in/out. */}
          <p
            data-testid="channel-submit-error"
            role={submitError ? 'alert' : undefined}
            className={`min-h-[1.25rem] text-sm ${
              submitError ? 'text-destructive' : ''
            }`}
          >
            {submitError || ' '}
          </p>

          {/* On mobile the Cancel/Create controls move to the dialog's
              top-right header (see mobileCloseLabel/mobileAction above);
              desktop keeps the classic bottom footer. */}
          {!isMobile && (
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {createChannel.isPending ? 'Creating...' : 'Create Channel'}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
