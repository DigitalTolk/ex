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
import { channelName, channelNameDraft } from '@/lib/channel-name';
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
  // `name` is what the field shows: a draft that may end in a hyphen, or,
  // mid-composition, raw text. `finalName` is the channel it stands for.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [submitError, setSubmitError] = useState('');
  // The last name the server answered "already exists" for.
  const [takenName, setTakenName] = useState<string | null>(null);
  const createChannel = useCreateChannel();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const autoFocusTextInput = useAutoFocusTextInput();
  const locale = navigator.language;

  const finalName = channelName(name, locale);
  const nameError =
    finalName === takenName
      ? `~${finalName} already exists`
      : (validateChannelName(finalName)?.message ?? null);

  const descriptionError = useMemo(
    () => validateChannelDescription(description),
    [description],
  );

  const descLen = countCodepoints(description);

  // Rewrites the field into a channel name. Giving a controlled input a
  // different value moves its caret to the end, so the caret is put back
  // after what the text before it became.
  function rewriteName(input: HTMLInputElement) {
    const typed = input.value;
    const draft = channelNameDraft(typed, locale);
    if (draft !== typed) {
      // A text input always has a selection; only other input types have none.
      const caret = channelNameDraft(typed.slice(0, input.selectionStart!), locale).length;
      input.value = draft;
      input.setSelectionRange(caret, caret);
    }
    setName(draft);
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    // Mid-composition (a dead key, an IME) a rewrite would break the
    // character being composed; compositionend rewrites it.
    if ((e.nativeEvent as InputEvent).isComposing) {
      setName(e.currentTarget.value);
      return;
    }
    rewriteName(e.currentTarget);
  }

  function reset() {
    setName('');
    setDescription('');
    setIsPrivate(false);
    setSubmitError('');
    setTakenName(null);
  }

  // Shared by the desktop form submit and the mobile top-bar Create button
  // (which lives outside the <form>, in the dialog's mobile header).
  function submit() {
    setSubmitError('');
    if (!finalName || nameError || descriptionError) return;

    const submitted = finalName;
    setName(submitted);
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
            setTakenName(submitted);
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
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="channel-name">Name</Label>
              <span
                data-testid="channel-name-counter"
                className={`text-xs tabular-nums ${
                  finalName.length > MAX_CHANNEL_NAME_LEN ? 'text-destructive' : 'text-muted-foreground'
                }`}
              >
                {finalName.length}/{MAX_CHANNEL_NAME_LEN}
              </span>
            </div>
            <div className="relative">
              {/* The channel prefix, right-aligned in a box exactly as wide
                  as the field's left padding, so it hugs the first letter
                  whatever the font's glyph width. The padding is restated
                  at mobile: because the field's base mobile:px-4 outranks
                  a plain pl-5 below 768px (see SearchInput). */}
              <span
                aria-hidden
                data-testid="channel-name-prefix"
                className="pointer-events-none absolute inset-y-0 left-0 flex w-5 items-center justify-end text-base text-muted-foreground not-mobile:text-sm mobile:w-7"
              >
                ~
              </span>
              <Input
                id="channel-name"
                value={name}
                onChange={handleNameChange}
                onCompositionEnd={(e) => rewriteName(e.currentTarget)}
                onBlur={() => setName(finalName)}
                className="pl-5 mobile:pl-7"
                required
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={autoFocusTextInput}
                aria-invalid={nameError ? 'true' : 'false'}
                aria-describedby="channel-name-help"
              />
            </div>
            {/* Reserved fixed-height slot — keeps the modal from jumping
                vertically as the validation message appears/disappears. */}
            <p
              id="channel-name-help"
              data-testid="channel-name-help"
              role={nameError ? 'alert' : undefined}
              className="min-h-[1.25rem] text-xs text-destructive"
            >
              {nameError ?? ' '}
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
