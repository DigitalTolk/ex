import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { useChannelName } from '@/hooks/useChannelName';
import { MAX_CHANNEL_NAME_LEN } from '@/lib/limits';

// The channel-name field of the dialogs that make a channel (creating one,
// turning a group message into one).

export function ChannelNameField({ field, autoFocus }: { field: ReturnType<typeof useChannelName>; autoFocus: boolean }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor="channel-name">Name</Label>
        <span
          data-testid="channel-name-counter"
          className={`text-xs tabular-nums ${
            field.finalName.length > MAX_CHANNEL_NAME_LEN ? 'text-destructive' : 'text-muted-foreground'
          }`}
        >
          {field.finalName.length}/{MAX_CHANNEL_NAME_LEN}
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
          {...field.inputProps}
          className="pl-5 mobile:pl-7"
          required
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-invalid={field.nameError ? 'true' : 'false'}
          aria-describedby="channel-name-help"
        />
      </div>
      {/* Reserved fixed-height slot — keeps the modal from jumping
          vertically as the validation message appears/disappears. */}
      <p
        id="channel-name-help"
        data-testid="channel-name-help"
        role={field.nameError ? 'alert' : undefined}
        className="min-h-[1.25rem] text-xs text-destructive"
      >
        {field.nameError ?? ' '}
      </p>
    </div>
  );
}
