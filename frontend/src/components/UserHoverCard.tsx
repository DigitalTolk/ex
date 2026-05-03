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
import { usePresence } from '@/context/PresenceContext';
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
  children,
}: UserHoverCardProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const navigate = useNavigate();
  // Mention hovers know only userId; author hovers pass `online` and
  // `avatarURL` from their userMap. Fall back to global presence and
  // the lazy /users fetch so both paths render identical chrome.
  const presence = usePresence();
  const effectiveOnline = online ?? presence.isOnline(userId);

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
    enabled: open,
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
        className="inline-flex cursor-pointer items-center gap-1 align-middle"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {children}
        {showInlineStatus && <UserStatusIndicator status={effectiveStatus} />}
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
        className="w-72 rounded-md border bg-popover p-3 shadow-lg"
      >
        <div>
          <div data-testid="hover-card-header" className="flex items-start gap-3">
            <div className="relative">
              <Avatar className="h-12 w-12">
                {effectiveAvatar && <AvatarImage src={effectiveAvatar} alt="" />}
                <AvatarFallback className="bg-primary/10 text-sm">
                  {getInitials(displayName)}
                </AvatarFallback>
              </Avatar>
              <span
                data-testid="hover-online-dot"
                className={`absolute bottom-0 right-0 h-3 w-3 rounded-full ring-2 ring-popover ${
                  effectiveOnline ? 'bg-emerald-500' : 'bg-muted-foreground'
                }`}
                aria-label={effectiveOnline ? 'Online' : 'Offline'}
              />
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
                  <a className="hover:underline" href={`mailto:${userDetails.email}`}>{userDetails.email}</a>
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
      </PopoverPortal>
    </>
  );
}
