import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { copyToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

// How long the confirmation checkmark stays up before reverting to the copy
// glyph. Exported so tests assert against the same number the UI uses.
export const COPY_FEEDBACK_MS = 1500;

type ButtonProps = React.ComponentProps<typeof Button>;

interface CopyButtonProps extends Omit<ButtonProps, 'children' | 'onClick' | 'value'> {
  /** The text placed on the clipboard. */
  value: string;
  /**
   * What is being copied, phrased as the action: "Copy invite link",
   * "Copy General URL". Used for both aria-label and the tooltip while at
   * rest; both flip to "Copied" during the confirmation window.
   */
  label: string;
}

/**
 * The single copy affordance for the whole app: an icon button that swaps its
 * glyph to a checkmark for {@link COPY_FEEDBACK_MS} after a successful copy.
 *
 * Everything that puts text on the clipboard from a piece of chrome goes
 * through this — webhook URLs, invite links, password-reset links, code
 * blocks. Before it existed the four call sites had drifted into three
 * different treatments (icon+checkmark, a plain "Copy" text button with no
 * feedback at all, and a bespoke hover-revealed button), and two of them
 * called `navigator.clipboard` directly, so they silently no-oped in the
 * non-secure-context / older-webview cases `copyToClipboard` exists to cover.
 *
 * The glyph is sized by the Button's own size variant (the svg carries no
 * explicit dimensions), so `size` is the only knob a caller needs.
 */
export function CopyButton({
  value,
  label,
  variant = 'ghost',
  size = 'icon-sm',
  className,
  ...rest
}: CopyButtonProps) {
  // A monotonic token rather than a boolean: clicking again while the
  // checkmark is still up must RESTART the window, which a boolean already
  // set to true cannot express (no state change → no effect re-run → the
  // checkmark would vanish on the first click's schedule).
  const [copiedToken, setCopiedToken] = useState(0);
  const copied = copiedToken > 0;

  useEffect(() => {
    if (copiedToken === 0) return;
    const timer = window.setTimeout(() => setCopiedToken(0), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copiedToken]);

  async function handleCopy() {
    await copyToClipboard(value);
    setCopiedToken((token) => token + 1);
  }

  const Icon = copied ? Check : Copy;
  const accessibleLabel = copied ? 'Copied' : label;

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={() => void handleCopy()}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      data-copied={copied ? 'true' : 'false'}
      className={className}
      {...rest}
    >
      <Icon className={cn(copied && 'text-online')} aria-hidden />
    </Button>
  );
}
