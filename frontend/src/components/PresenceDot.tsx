import { cn } from '@/lib/utils';

// The one presence indicator implementation (pair it with
// presenceNotchStyle on the avatar it sits on). State is encoded by SHAPE
// as well as color for color-blind users: online = solid filled dot,
// offline = hollow ring (border only) — the same affordance Slack uses.
// Size is in px: it must agree with the avatar's notch mask, so it's
// numeric rather than a Tailwind class.
export function PresenceDot({
  online,
  size = 8,
  inset = 0,
  className,
  testId,
}: {
  online: boolean;
  size?: number;
  inset?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-presence={online ? 'online' : 'offline'}
      className={cn(
        'absolute rounded-full',
        online ? 'bg-online' : 'border-solid border-muted-foreground bg-transparent',
        className,
      )}
      style={{
        width: size,
        height: size,
        right: inset,
        bottom: inset,
        // Explicit inline border so every engine (WebKit included) resolves
        // the hollow ring identically regardless of utility-class cascade.
        borderStyle: online ? 'none' : 'solid',
        borderWidth: online ? 0 : Math.max(1.5, size / 4.5),
      }}
      aria-label={online ? 'Online' : 'Offline'}
    />
  );
}
