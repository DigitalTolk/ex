import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { Globe, MessageSquare, MoreVertical } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { UserStatusIndicator } from '@/components/UserStatusIndicator';
import { matchRank } from '@/lib/fuzzy';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useBrowseChannels, useJoinChannel, useUserChannels } from '@/hooks/useChannels';
import { useOpenDM } from '@/hooks/useConversations';
import { useAuth } from '@/context/AuthContext';
import { usePresence } from '@/context/PresenceContext';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useDirectoryUsers, useSetUserRole, useSetUserStatus } from '@/hooks/useDirectoryUsers';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getInitials } from '@/lib/format';
import { PresenceDot } from '@/components/PresenceDot';
import { PasswordResetDialog } from '@/components/PasswordResetDialog';
import { presenceNotchStyle } from '@/lib/presence';
import { deactivatedLast, isDeactivated } from '@/lib/deactivated';
import { formatLastSeen, formatTimeZoneDelta, formatTimeZoneName, isValidTimeZone } from '@/lib/user-time';
import type { User } from '@/types';
import { SearchInput } from '@/components/ui/search-input';

type Tab = 'channels' | 'members';

function capitalize(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function DirectoriesPage() {
  useDocumentTitle('Directory');
  const { section } = useParams<{ section?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const activeSection = section ?? location.pathname.split('/').filter(Boolean).at(-1);
  const tab: Tab = activeSection === 'users' ? 'members' : 'channels';
  const { user } = useAuth();
  const isAdmin = user?.systemRole === 'admin';

  return (
    <PageContainer title="Directory">
      <div role="tablist" aria-label="Directory sections" className="flex gap-1 border-b">
        <button
          role="tab"
          aria-selected={tab === 'channels'}
          onClick={() => navigate('/directory/channels')}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'channels'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Channels
        </button>
        <button
          role="tab"
          aria-selected={tab === 'members'}
          onClick={() => navigate('/directory/users')}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'members'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Members
        </button>
      </div>

      {tab === 'channels' ? <ChannelsTab /> : <MembersTab isAdmin={isAdmin} currentUserId={user?.id} />}
    </PageContainer>
  );
}

function ChannelsTab() {
  const [query, setQuery] = useState('');
  const { data: allChannels, isLoading } = useBrowseChannels();
  const { data: userChannels } = useUserChannels();
  const joinChannel = useJoinChannel();
  const navigate = useNavigate();

  const joinedIds = new Set(userChannels?.map((c) => c.channelID) ?? []);

  // Best matches first (the channel of that name before ones whose
  // description mentions it); equal matches keep their order.
  const visible = (allChannels ?? [])
    .filter((ch) => ch.type === 'public')
    .map((ch) => ({ ch, rank: matchRank(query, ch.name, ch.description ?? '') }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map(({ ch }) => ch);

  function handleJoin(channelId: string, channelSlug: string) {
    // Routes are keyed by slug (ChannelView resolves the slug back to a
    // channel record). Use the slug from the channel record rather than
    // the raw name so we always land on the right URL.
    joinChannel.mutate(channelId, {
      onSuccess: () => {
        navigate(`/channel/${channelSlug}`);
      },
    });
  }

  return (
    <>
      <SearchInput
        containerClassName="mb-4"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search channels..."
        aria-label="Search channels"
      />

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {!isLoading && visible.length === 0 && (
        <p className="py-12 text-center text-muted-foreground">
          {query.trim() ? 'No matching channels' : 'No channels available'}
        </p>
      )}

      <div className="space-y-1">
        {!isLoading && visible.map((channel) => {
            const alreadyJoined = joinedIds.has(channel.id);
            return (
              <div
                key={channel.id}
                className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/50"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Globe className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{channel.name}</p>
                  {channel.description && (
                    <p className="text-sm text-muted-foreground truncate">
                      {channel.description}
                    </p>
                  )}
                </div>
                {alreadyJoined ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/channel/${channel.slug}`)}
                  >
                    Open
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => handleJoin(channel.id, channel.slug)}
                    disabled={joinChannel.isPending}
                  >
                    Join
                  </Button>
                )}
              </div>
            );
          })}
      </div>
    </>
  );
}

interface MembersTabProps {
  isAdmin: boolean;
  currentUserId?: string;
}

function MembersTab({ isAdmin, currentUserId }: MembersTabProps) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);
  const [error, setError] = useState('');
  // The guest whose password reset dialog is open (null = closed).
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  // The account awaiting a deactivation confirm (null = closed).
  const [deactivateTarget, setDeactivateTarget] = useState<User | null>(null);
  const { isOnline } = usePresence();
  const { openDM, isPending: openDMPending } = useOpenDM();
  const { data: users = [], isLoading, error: fetchError } = useDirectoryUsers(debouncedQuery);
  const setUserRole = useSetUserRole();
  const setUserStatus = useSetUserStatus();

  const visibleError = error || (fetchError instanceof Error ? fetchError.message : fetchError ? 'Failed to load users' : '');

  function changeRole(userId: string, role: User['systemRole']) {
    setError('');
    setUserRole.mutate(
      { userId, role },
      { onError: (err) => setError(err instanceof Error ? err.message : 'Failed to change role') },
    );
  }

  function setStatus(userId: string, deactivated: boolean) {
    setError('');
    setUserStatus.mutate(
      { userId, deactivated },
      { onError: (err) => setError(err instanceof Error ? err.message : 'Failed to update status') },
    );
  }

  function handleMessage(userId: string) {
    openDM(userId);
  }

  // The summary counts the people you can reach: deactivated accounts are
  // listed (last) but not counted.
  const activeUsers = users.filter((u) => !isDeactivated(u));
  const onlineCount = activeUsers.reduce((n, u) => (isOnline(u.id) ? n + 1 : n), 0);
  // Deactivated accounts sit at the end, so the people you can reach come
  // first — re-sorted live as a user.updated flips someone's status.
  const listed = deactivatedLast(users);
  // As many 16rem-or-wider columns as fit, stretched to fill the row exactly.
  const memberGridClassName = 'grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]';

  return (
    <>
      <SearchInput
        containerClassName="mb-4"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search members..."
        aria-label="Search members"
      />

      {visibleError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive mb-4" role="alert">
          {visibleError}
        </div>
      )}

      {isLoading && (
        <div className={memberGridClassName} data-testid="members-grid-loading">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[4/5] w-full" />
          ))}
        </div>
      )}

      {!isLoading && users.length === 0 && (
        <p className="py-12 text-center text-muted-foreground">No members found</p>
      )}

      {!isLoading && users.length > 0 && (
        <p className="mb-3 text-xs text-muted-foreground" data-testid="members-summary">
          {activeUsers.length} member{activeUsers.length !== 1 ? 's' : ''} · {onlineCount} online
        </p>
      )}

      <div className={memberGridClassName} data-testid="members-grid">
        {!isLoading && listed.map((u) => {
          const inactive = isDeactivated(u);
          const online = isOnline(u.id);
          const isSelf = u.id === currentUserId;
          const effectiveTimeZone = isValidTimeZone(u.timeZone) ? u.timeZone : undefined;
          const timeZoneDelta = formatTimeZoneDelta(effectiveTimeZone);
          const timeZoneName = formatTimeZoneName(effectiveTimeZone);
          const lastSeen = formatLastSeen(u.lastSeenAt, online);
          return (
            <div
              key={u.id}
              data-testid="directory-user-card"
              data-inactive={inactive || undefined}
              className="group flex flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:bg-muted/40"
            >
              <div className="relative aspect-square w-full bg-muted" data-testid="directory-user-avatar">
                <Avatar
                  className={`h-full w-full rounded-none after:rounded-none ${inactive ? 'opacity-60 grayscale' : ''}`}
                  style={presenceNotchStyle(12, 8)}
                >
                  {u.avatarURL && <AvatarImage src={u.avatarURL} alt="" className="rounded-none" />}
                  <AvatarFallback className="rounded-none bg-primary/10 text-3xl">
                    {getInitials(u.displayName || '??')}
                  </AvatarFallback>
                </Avatar>
                <PresenceDot online={online} size={12} inset={8} testId={`presence-${u.id}`} />
                <Badge
                  variant={u.systemRole === 'admin' ? 'default' : 'secondary'}
                  data-testid={`role-pill-${u.id}`}
                  className="absolute bottom-2 left-2 bg-background/85 text-xs text-foreground shadow-sm"
                >
                  {capitalize(u.systemRole)}
                </Badge>
              </div>
              {/* The actions sit at the bottom (mt-auto), level across a row
                  of cards however much each one has to show. */}
              <div className="flex flex-1 flex-col gap-2 p-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  <p className="font-medium truncate">{u.displayName}</p>
                  <UserStatusIndicator status={u.userStatus} />
                  {isSelf && (
                    <span className="text-xs text-muted-foreground">(you)</span>
                  )}
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  <a
                    className="text-sm text-link transition-colors hover:text-link/80"
                    href={`mailto:${u.email}`}
                  >
                    {u.email}
                  </a>
                </p>
                {inactive && (
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge
                      variant="destructive"
                      data-testid={`status-pill-${u.id}`}
                      className="text-sm h-auto py-0.5"
                    >
                      Inactive
                    </Badge>
                  </div>
                )}
                <dl className="space-y-2 text-xs text-muted-foreground md:space-y-1">
                  {u.phone && (
                    <div className="md:flex md:justify-between md:gap-2" data-testid="directory-meta-phone">
                      <dt className="font-medium text-muted-foreground md:font-normal">Phone</dt>
                      <dd className="mt-0.5 min-w-0 truncate md:mt-0 md:text-right">
                        <a className="text-link transition-colors hover:text-link/80" href={`tel:${u.phone}`}>
                          {u.phone}
                        </a>
                      </dd>
                    </div>
                  )}
                  {u.manager && (
                    <div className="md:flex md:justify-between md:gap-2" data-testid="directory-meta-manager">
                      <dt className="font-medium text-muted-foreground md:font-normal">Manager</dt>
                      <dd className="mt-0.5 min-w-0 truncate text-foreground md:mt-0 md:text-right md:text-muted-foreground">
                        {u.manager.displayName}
                      </dd>
                    </div>
                  )}
                  {effectiveTimeZone && (
                    <div className="md:flex md:justify-between md:gap-2" data-testid="directory-meta-local-time">
                      <dt className="font-medium text-muted-foreground md:font-normal">Local time</dt>
                      <dd className="mt-0.5 text-foreground md:mt-0 md:text-right md:text-muted-foreground">
                        {new Date().toLocaleTimeString(undefined, { timeZone: effectiveTimeZone, hour: 'numeric', minute: '2-digit' })}
                        {timeZoneDelta && <span className="ml-1">({timeZoneDelta})</span>}
                      </dd>
                    </div>
                  )}
                  {timeZoneName && (
                    <div className="md:flex md:justify-between md:gap-2" data-testid="directory-meta-timezone">
                      <dt className="font-medium text-muted-foreground md:font-normal">Timezone</dt>
                      <dd className="mt-0.5 min-w-0 truncate text-foreground md:mt-0 md:text-right md:text-muted-foreground">{timeZoneName}</dd>
                    </div>
                  )}
                  {lastSeen && (
                    <div className="md:flex md:justify-between md:gap-2" data-testid="directory-meta-last-seen">
                      <dt className="font-medium text-muted-foreground md:font-normal">Last seen</dt>
                      <dd className="mt-0.5 text-foreground md:mt-0 md:text-right md:text-muted-foreground">{lastSeen}</dd>
                    </div>
                  )}
                </dl>
                <div className="mt-auto flex items-center justify-between gap-2" data-testid="directory-card-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleMessage(u.id)}
                    disabled={openDMPending}
                    aria-label={isSelf ? 'Open notes-to-self' : `Message ${u.displayName}`}
                    className="h-8 min-w-0 flex-1"
                  >
                    <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                    Message
                  </Button>
                  {isAdmin && !isSelf && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className={buttonVariants({ size: 'sm', variant: 'outline', className: 'h-8 w-8 shrink-0 p-0' })}
                        aria-label={`Manage ${u.displayName}`}
                      >
                        <MoreVertical className="h-3.5 w-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem
                          onClick={() => changeRole(u.id, 'admin')}
                          disabled={u.systemRole === 'admin' || u.systemRole === 'guest' || u.authProvider === 'guest'}
                        >
                          Promote to Admin
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => changeRole(u.id, 'member')}
                          disabled={u.systemRole === 'member' || u.systemRole === 'guest' || u.authProvider === 'guest'}
                        >
                          Set as Member
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => changeRole(u.id, 'guest')}
                          disabled={u.systemRole === 'guest'}
                        >
                          Set as Guest
                        </DropdownMenuItem>
                        {/* Password actions are guest-only: an SSO user's
                            credential lives in the identity provider, and the
                            server rejects a reset for one. */}
                        {u.authProvider === 'guest' && (
                          <DropdownMenuItem
                            onClick={() => setResetTarget(u)}
                            data-testid={`reset-password-${u.id}`}
                          >
                            Reset password
                          </DropdownMenuItem>
                        )}
                        {inactive ? (
                          <DropdownMenuItem
                            onClick={() => setStatus(u.id, false)}
                            data-testid={`reactivate-${u.id}`}
                          >
                            Reactivate
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() => setDeactivateTarget(u)}
                            data-testid={`deactivate-${u.id}`}
                          >
                            Deactivate
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Mounted only while a target is selected, so each guest gets a fresh
          dialog — see PasswordResetDialog's docblock. */}
      {resetTarget && (
        <PasswordResetDialog user={resetTarget} onClose={() => setResetTarget(null)} />
      )}

      {deactivateTarget && (
        <ConfirmDialog
          open
          // Mounted only while open, so any change closes it.
          onOpenChange={() => setDeactivateTarget(null)}
          title={`Deactivate ${deactivateTarget.displayName}?`}
          confirmLabel="Deactivate"
          destructive
          onConfirm={() => setStatus(deactivateTarget.id, true)}
          testIDPrefix="deactivate-user"
        />
      )}
    </>
  );
}
