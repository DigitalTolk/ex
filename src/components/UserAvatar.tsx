import { memo, useState } from 'react';
import { getInitials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PresenceDot } from '@/components/PresenceDot';
import { presenceNotchStyle } from '@/lib/presence';

interface UserAvatarProps {
  displayName: string;
  avatarURL?: string;
  // Presence: undefined hides the dot entirely (caller doesn't track
  // presence for this user). true / false render the green / muted dot.
  online?: boolean;
  // Tailwind size class for the Avatar (e.g. "h-7 w-7"). Default mirrors
  // the member-list density.
  className?: string;
  // Presence dot diameter in px — numeric so the avatar's notch mask and
  // the dot stay in lockstep. Default reads well at the h-7 avatar size.
  dotSize?: number;
}

// Avatar with an inline presence dot. Memoized + direct `<img>` so
// the same URL across many rows shares a single cached image instance
// and re-mounts during virtualised scrolling don't trigger a fresh
// probe each time. Radix's AvatarPrimitive.Image uses `new Image()`
// on every mount to detect load/error, which means every off-screen
// → on-screen transition flashes the initials fallback even though
// the bytes are sitting in the browser's HTTP cache. We render the
// `<img>` ourselves and only flip to the fallback on real error.
export const UserAvatar = memo(function UserAvatar({
  displayName,
  avatarURL,
  online,
  className = 'h-7 w-7',
  dotSize = 8,
}: UserAvatarProps) {
  const [imageBroken, setImageBroken] = useState(false);
  const showImage = !!avatarURL && !imageBroken;

  return (
    <span className="relative inline-block">
      <span
        data-slot="avatar"
        className={cn(
          'relative flex shrink-0 overflow-hidden rounded-full bg-muted',
          className,
        )}
        style={online !== undefined ? presenceNotchStyle(dotSize) : undefined}
      >
        {showImage ? (
          <img
            src={avatarURL}
            alt=""
            // decoding=async + the stable URL identity keeps multiple
            // <UserAvatar> instances pointing at the same image
            // sharing the browser's in-memory decode cache instead of
            // each kicking off a separate load probe.
            decoding="async"
            loading="lazy"
            onError={() => setImageBroken(true)}
            data-slot="avatar-image"
            className="aspect-square size-full rounded-full object-cover"
          />
        ) : (
          <span
            data-slot="avatar-fallback"
            className="flex size-full items-center justify-center rounded-full bg-primary/10 text-[10px]"
          >
            {getInitials(displayName || '??')}
          </span>
        )}
      </span>
      {online !== undefined && <PresenceDot online={online} size={dotSize} />}
    </span>
  );
});
