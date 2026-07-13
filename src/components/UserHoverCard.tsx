import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MessageSquare } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { getInitials } from '@/lib/format';
import { PopoverPortal } from '@/components/PopoverPortal';
import { UserStatusIndicator } from '@/components/UserStatusIndicator';
import { PresenceDot } from '@/components/PresenceDot';
import { presenceNotchStyle } from '@/lib/presence';
import { useIsOnline } from '@/stores/presence';
import { formatStatusUntil } from '@/lib/user-status';
import { formatLastSeen, formatTimeZoneDelta, formatTimeZoneName, isValidTimeZone } from '@/lib/user-time';
import type { Conversation, User, UserStatus } from '@/types';

interface UserHoverCardProps {
  userId: string;
  displayName: string;
  avatarURL?: string;
  userStatus?: UserStatus;
  online?: boolean;
  currentUserId?: string;
  showInlineStatus?: boolean;
  triggerClassName?: string;
  // When set, the card renders the minimal "integration" variant: the
  // display name + "This post was created by an integration from @owner",
  // with no status/email/timezone/DM fields and no user fetch. Used for
  // incoming-webhook posts so they read as an integration, not the creator.
  integrationOwnerName?: string;
  children: ReactNode;
}

export function UserHoverCard({
  userId,
  displayName,
  avatarURL,
  userStatus,
  online,
  currentUserId,
  showInlineStatus = true,
  triggerClassName = 'inline-flex cursor-pointer items-center gap-1 align-middle',
  integrationOwnerName,
  children,
}: UserHoverCardProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const navigate = useNavigate();
  // Mention hovers know only userId; author hovers pass `online` and
  // `avatarURL` from their userMap. Fall back to the per-user presence
  // selector (re-renders only when THIS user's flag flips) and the lazy
  // /users fetch so both paths render identical chrome.
  const storeOnline = useIsOnline(userId);
  const effectiveOnline = online ?? storeOnline;

  const startDM = useMutation({
    mutationFn: () =>
      apiFetch<Conversation>('/api/v1/conversations', {
        method: 'POST',
        body: JSON.stringify({ type: 'dm', participantIDs: [userId] }),
      }),
    onSuccess: (conv) => {
      navigate(`/conversation/${conv.id}`);
      setOpen(false);
    },
  });

  // Fetch user details lazily on first open. Non-admin viewers receive a
  // limited payload (status, displayName, avatarURL); admins get the full
  // record including authProvider — both paths are sufficient to render
  // the inactive badge correctly.
  const { data: userDetails } = useQuery<Partial<User>>({
    queryKey: queryKeys.user(userId),
    queryFn: () => apiFetch<Partial<User>>(`/api/v1/users/${userId}`),
    enabled: open && !integrationOwnerName,
    staleTime: 30_000,
  });
  const inactive = userDetails?.status === 'deactivated';
  const effectiveAvatar = avatarURL ?? userDetails?.avatarURL;
  const effectiveStatus = userStatus ?? userDetails?.userStatus;
  const lastSeen = formatLastSeen(userDetails?.lastSeenAt, effectiveOnline);
  const effectiveTimeZone = isValidTimeZone(userDetails?.timeZone) ? userDetails.timeZone : undefined;
  const timeZoneDelta = formatTimeZoneDelta(effectiveTimeZone);
  const timeZoneName = formatTimeZoneName(effectiveTimeZone);

  const isSelf = currentUserId === userId;

  return (
    <>
      <span
        ref={triggerRef}
        className={triggerClassName}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {children}
        {showInlineStatus && !integrationOwnerName && <UserStatusIndicator status={effectiveStatus} />}
      </span>
      <PopoverPortal
        open={open}
        triggerRef={triggerRef}
        onDismiss={() => setOpen(false)}
        estimatedHeight={180}
        estimatedWidth={288}
        preferredSide="bottom"
        preferredAlign="start"
        role="tooltip"
        mobileSheet
        className="w-72 rounded-md border bg-popover p-3 shadow-lg mobile:w-screen mobile:max-w-none mobile:rounded-b-none mobile:rounded-t-xl mobile:border-b-0 mobile:pb-[calc(env(safe-area-inset-bottom)+0.75rem)] mobile:pl-[max(0.75rem,env(safe-area-inset-left))] mobile:pr-[max(0.75rem,env(safe-area-inset-right))]"
      >
        {integrationOwnerName ? (
          <div data-testid="hover-card-integration">
            <div className="flex items-start gap-3">
              <Avatar className="h-12 w-12">
                {avatarURL && <AvatarImage src={avatarURL} alt="" />}
                <AvatarFallback className="bg-primary/10 text-sm">
                  {getInitials(displayName)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm font-semibold">{displayName}</p>
                <p className="text-xs text-muted-foreground">Integration</p>
              </div>
            </div>
            <p className="mt-3 text-sm leading-snug text-muted-foreground">
              This post was created by an integration from @{integrationOwnerName}.
            </p>
          </div>
        ) : (
        <div>
          <div data-testid="hover-card-header" className="flex items-start gap-3">
            <div className="relative">
              <Avatar className="h-12 w-12" style={presenceNotchStyle(12)}>
                {effectiveAvatar && <AvatarImage src={effectiveAvatar} alt="" />}
                <AvatarFallback className="bg-primary/10 text-sm">
                  {getInitials(displayName)}
                </AvatarFallback>
              </Avatar>
              <PresenceDot online={effectiveOnline} size={12} testId="hover-online-dot" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-semibold">{displayName}</p>
                <UserStatusIndicator status={effectiveStatus} tooltip={false} />
                {inactive && (
                  <Badge variant="destructive" data-testid="hover-status-inactive">
                    Inactive
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {effectiveOnline ? 'Online' : 'Offline'}
              </p>
              {effectiveStatus && (
                <p
                  data-testid="hover-status-line"
                  title={formatStatusUntil(effectiveStatus.clearAt)}
                  className="mt-1 whitespace-normal break-words text-xs leading-snug text-muted-foreground"
                >
                  {effectiveStatus.text}
                </p>
              )}
            </div>
          </div>
          <dl className="mt-3 space-y-1 text-xs">
            {userDetails?.email && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Email</dt>
                <dd className="truncate">
                  <a
                    className="text-link transition-colors hover:text-link/80"
                    href={`mailto:${userDetails.email}`}
                  >
                    {userDetails.email}
                  </a>
                </dd>
              </div>
            )}
            {effectiveTimeZone && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Local time</dt>
                <dd className="text-right">
                  {new Date().toLocaleTimeString(undefined, { timeZone: effectiveTimeZone, hour: 'numeric', minute: '2-digit' })}
                  {timeZoneDelta && <span className="ml-1 text-muted-foreground">({timeZoneDelta})</span>}
                </dd>
              </div>
            )}
            {userDetails?.phone && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Phone</dt>
                <dd className="truncate">
                  <a
                    className="text-link transition-colors hover:text-link/80"
                    href={`tel:${userDetails.phone}`}
                  >
                    {userDetails.phone}
                  </a>
                </dd>
              </div>
            )}
            {userDetails?.manager && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Manager</dt>
                <dd className="min-w-0 text-right">
                  <span className="break-words">{userDetails.manager.displayName}</span>
                </dd>
              </div>
            )}
            {timeZoneName && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Timezone</dt>
                <dd className="min-w-0 text-right">
                  <span className="break-words">{timeZoneName}</span>
                </dd>
              </div>
            )}
            {lastSeen && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Last seen</dt>
                <dd>{lastSeen}</dd>
              </div>
            )}
          </dl>
          {!isSelf && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3 w-full"
              onClick={() => startDM.mutate()}
              disabled={startDM.isPending}
            >
              <MessageSquare className="mr-2 h-3.5 w-3.5" />
              Direct message
            </Button>
          )}
        </div>
        )}
      </PopoverPortal>
    </>
  );
}
