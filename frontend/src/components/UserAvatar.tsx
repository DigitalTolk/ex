import { memo, useState } from 'react';
import { getInitials } from '@/lib/format';
import { cn } from '@/lib/utils';

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
  dotClassName = 'h-2 w-2',
  dotRingClassName = 'ring-background',
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
});
