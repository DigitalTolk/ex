import { Check } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';
import { UserStatusIndicator } from '@/components/UserStatusIndicator';
import { Badge } from '@/components/ui/badge';
import type { UserStatus } from '@/types';

export interface UserPickerRowProps {
  displayName: string;
  email?: string;
  avatarURL?: string;
  // Presence: undefined hides the dot (caller doesn't track presence);
  // true/false render the green/muted dot — the UserAvatar contract.
  online?: boolean;
  userStatus?: UserStatus | null;
  // Keyboard/hover highlight (aria-selected).
  highlighted?: boolean;
  // The person is already a member of the target (channel add-member): show
  // the indicator and make the row inert instead of hiding them — seeing
  // "already added" answers the question a hidden row leaves open.
  added?: boolean;
  // Appends "(you)" after the name (new-conversation picker).
  you?: boolean;
  testID?: string;
  onHover?: () => void;
  onSelect: () => void;
  // Pick on mousedown so selection beats an input blur (dropdowns attached
  // to a text field). onSelect stays wired to click as the touch fallback —
  // callers keep pick() idempotent.
  pickOnMouseDown?: boolean;
}

// The ONE user row for every people dropdown (global search, add-member,
// new-conversation). Mirrors the design everywhere a person is listed:
// avatar with presence notch, name, custom-status emoji, muted email.
// Extend THIS component rather than re-implementing the row.
export function UserPickerRow({
  displayName,
  email,
  avatarURL,
  online,
  userStatus,
  highlighted = false,
  added = false,
  you = false,
  testID,
  onHover,
  onSelect,
  pickOnMouseDown = false,
}: UserPickerRowProps) {
  return (
    <button
      type="button"
      data-testid={testID}
      disabled={added}
      onMouseEnter={onHover}
      onMouseDown={
        pickOnMouseDown && !added
          ? (e) => {
              e.preventDefault();
              onSelect();
            }
          : undefined
      }
      onClick={added ? undefined : onSelect}
      aria-selected={highlighted}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm mobile:py-3 mobile:text-base ${
        highlighted ? 'bg-muted' : added ? '' : 'hover:bg-muted/50'
      } ${added ? 'cursor-default opacity-60' : ''}`}
    >
      <UserAvatar displayName={displayName} avatarURL={avatarURL} online={online} className="h-6 w-6 shrink-0" dotSize={8} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate font-medium">{displayName}</span>
        {you && <span className="shrink-0 text-xs text-muted-foreground">(you)</span>}
        {/* Custom-status emoji — self-hides when the person has no active
            status, so rows stay clean. tooltip=false: nesting a TooltipTrigger
            inside this row button would nest interactive elements. */}
        <UserStatusIndicator status={userStatus} tooltip={false} className="h-4 w-4" />
        {email && <span className="truncate text-muted-foreground">{email}</span>}
      </span>
      {added && (
        <Badge variant="outline" className="shrink-0 gap-1" data-testid={testID ? `${testID}-added` : undefined}>
          <Check className="h-3 w-3" aria-hidden="true" />
          Added
        </Badge>
      )}
    </button>
  );
}
