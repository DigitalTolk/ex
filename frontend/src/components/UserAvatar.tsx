import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitials } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { UserStatus } from '@/types';

interface UserAvatarProps {
  displayName: string;
  avatarURL?: string;
  // Presence: undefined hides the dot entirely (caller doesn't track
  // presence for this user). true / false render the green / muted dot.
  online?: boolean;
  // Tailwind size class for the Avatar (e.g. "h-7 w-7"). Default mirrors
  // the member-list density.
  className?: string;
  // Tailwind size class for the presence dot. Picked to read well at
  // the default avatar size; override when the avatar is larger.
  dotClassName?: string;
  // Ring color for the presence dot — `ring-background` matches a
  // sidebar/list backdrop; switch to `ring-popover` inside hover cards
  // and similar floating surfaces.
  dotRingClassName?: string;
  userStatus?: UserStatus | null;
}

// Avatar with an inline presence dot, sharing one set of styles
// across the member list and the @-mention typeahead so the two
// surfaces match. Renders as a `relative inline-block` so the dot
// can position-absolute against the avatar without coupling the
// caller's layout.
export function UserAvatar({
  displayName,
  avatarURL,
  online,
  className = 'h-7 w-7',
  dotClassName = 'h-2 w-2',
  dotRingClassName = 'ring-background',
  userStatus: _userStatus,
}: UserAvatarProps) {
  return (
    <span className="relative inline-block">
      <Avatar className={cn('shrink-0', className)}>
        {avatarURL && <AvatarImage src={avatarURL} alt="" />}
        <AvatarFallback className="bg-primary/10 text-[10px]">
          {getInitials(displayName || '??')}
        </AvatarFallback>
      </Avatar>
      {online !== undefined && (
        <span
          className={cn(
            'absolute bottom-0 right-0 rounded-full ring-2',
            dotClassName,
            dotRingClassName,
            online ? 'bg-emerald-500' : 'bg-muted-foreground',
          )}
          aria-label={online ? 'Online' : 'Offline'}
        />
      )}
    </span>
  );
}
