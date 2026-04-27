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
import {
  MAX_CHANNEL_DESCRIPTION_LEN,
  MAX_CHANNEL_NAME_LEN,
  countCodepoints,
  validateChannelDescription,
  validateChannelName,
} from '@/lib/limits';

interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateChannelDialog({
  open,
  onOpenChange,
}: CreateChannelDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const createChannel = useCreateChannel();
  const navigate = useNavigate();

  // Validation runs on every keystroke. We DON'T render the error while
  // the field is empty (would scream at the user before they've typed)
  // — the required-field UX takes over via the Submit-disabled gate.
  const nameError = useMemo(() => {
    if (name.length === 0) return null;
    return validateChannelName(name);
  }, [name]);

  const descriptionError = useMemo(
    () => validateChannelDescription(description),
    [description],
  );

  const nameLen = countCodepoints(name);
  const descLen = countCodepoints(description);

  function reset() {
    setName('');
    setDescription('');
    setIsPrivate(false);
    setSubmitError('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError('');
    if (!name.trim()) return;
    if (nameError || descriptionError) return;

    createChannel.mutate(
      {
        name: name.trim(),
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
          // Surface backend-side validation messages too — the frontend
          // pre-check is permissive enough that this is mostly belt-and-
          // braces (server is authoritative).
          setSubmitError(err instanceof Error ? err.message : 'Failed to create channel');
        },
      },
    );
  }

  const canSubmit =
    !!name.trim() &&
    !nameError &&
    !descriptionError &&
    !createChannel.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="channel-name">Name</Label>
              <span
                data-testid="channel-name-counter"
                className={`text-xs tabular-nums ${
                  nameLen > MAX_CHANNEL_NAME_LEN ? 'text-destructive' : 'text-muted-foreground'
                }`}
              >
                {nameLen}/{MAX_CHANNEL_NAME_LEN}
              </span>
            </div>
            <Input
              id="channel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. marketing"
              required
              autoFocus
              aria-invalid={nameError ? 'true' : 'false'}
              aria-describedby="channel-name-help"
            />
            {/* Reserved fixed-height slot — keeps the modal from jumping
                vertically as the validation message appears/disappears.
                The help text and the error share the slot. */}
            <p
              id="channel-name-help"
              data-testid="channel-name-help"
              className={`min-h-[1.25rem] text-xs ${
                nameError ? 'text-destructive' : 'text-muted-foreground'
              }`}
            >
              {nameError
                ? nameError.message
                : 'Lowercase letters, digits and hyphens — like a URL slug.'}
            </p>
          </div>

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
              placeholder="What is this channel about?"
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
              {descriptionError ?? '\u00A0'}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="channel-private">Make private</Label>
              <p className="text-xs text-muted-foreground">
                Only invited members can see this channel
              </p>
            </div>
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
            {submitError || '\u00A0'}
          </p>

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
        </form>
      </DialogContent>
    </Dialog>
  );
}
