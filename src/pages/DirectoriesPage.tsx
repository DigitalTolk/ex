import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { Globe, MessageSquare, MoreVertical } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { UserStatusIndicator } from '@/components/UserStatusIndicator';
import { fuzzyMatch } from '@/lib/fuzzy';
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
import { apiFetch } from '@/lib/api';
import { getInitials } from '@/lib/format';
import { PresenceDot } from '@/components/PresenceDot';
import { PasswordResetDialog } from '@/components/PasswordResetDialog';
import { presenceNotchStyle } from '@/lib/presence';
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
    <PageContainer title="Directory" description="Browse channels and members in your workspace">
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

  const visible = (allChannels ?? [])
    .filter((ch) => ch.type === 'public')
    .filter((ch) => fuzzyMatch(query, ch.name, ch.description ?? ''));

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
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [error, setError] = useState('');
  // The guest whose password reset dialog is open (null = closed).
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const { isOnline } = usePresence();
  const { openDM, isPending: openDMPending } = useOpenDM();
  const qc = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const usersQueryKey = ['users-directory', debouncedQuery] as const;
  const { data: users = [], isLoading, error: fetchError } = useQuery({
    queryKey: usersQueryKey,
    queryFn: () =>
      apiFetch<User[]>(
        debouncedQuery.length >= 2
          ? `/api/v1/users?q=${encodeURIComponent(debouncedQuery)}`
          : '/api/v1/users',
      ),
  });

  // The WS user.updated bridge invalidates this query so an avatar /
  // display-name change anywhere in the app refreshes the directory.
  useEffect(() => {
    const onUpdate = () => qc.invalidateQueries({ queryKey: ['users-directory'] });
    window.addEventListener('ex:user-updated', onUpdate);
    return () => window.removeEventListener('ex:user-updated', onUpdate);
  }, [qc]);

  const visibleError = error || (fetchError instanceof Error ? fetchError.message : fetchError ? 'Failed to load users' : '');

  function patchUserCache(userId: string, patch: Partial<User>) {
    qc.setQueriesData<User[]>({ queryKey: ['users-directory'] }, (prev) =>
      prev?.map((u) => (u.id === userId ? { ...u, ...patch } : u)),
    );
  }

  async function changeRole(userId: string, newRole: 'admin' | 'member' | 'guest') {
    setError('');
    try {
      await apiFetch(`/api/v1/users/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      });
      patchUserCache(userId, { systemRole: newRole });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change role');
    }
  }

  async function setStatus(userId: string, deactivated: boolean) {
    setError('');
    try {
      await apiFetch(`/api/v1/users/${userId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ deactivated }),
      });
      patchUserCache(userId, { status: deactivated ? 'deactivated' : 'active' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    }
  }

  function handleMessage(userId: string) {
    openDM(userId);
  }

  const onlineCount = users.reduce((n, u) => (isOnline(u.id) ? n + 1 : n), 0);
  const memberGridClassName =
    'grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(16rem,calc((100%_-_3rem)/5)))] md:justify-start';

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
          {users.length} member{users.length !== 1 ? 's' : ''} · {onlineCount} online
        </p>
      )}

      <div className={memberGridClassName} data-testid="members-grid">
        {!isLoading && users.map((u) => {
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
              className="group items-start overflow-hidden rounded-lg border bg-card transition-colors hover:bg-muted/40"
            >
              <div className="relative aspect-square w-full bg-muted" data-testid="directory-user-avatar">
                <Avatar
                  className="h-full w-full rounded-none after:rounded-none"
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
                  className="absolute bottom-2 left-2 bg-background/85 text-[11px] text-foreground shadow-sm backdrop-blur"
                >
                  {capitalize(u.systemRole)}
                </Badge>
              </div>
              <div className="space-y-2 p-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  <p className="font-medium truncate">{u.displayName}</p>
                  <UserStatusIndicator status={u.userStatus} />
                  {isSelf && (
                    <span className="text-[10px] text-muted-foreground">(you)</span>
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
                <div className="flex flex-wrap items-center gap-1">
                  {u.status === 'deactivated' && (
                    <Badge
                      variant="destructive"
                      data-testid={`status-pill-${u.id}`}
                      className="text-sm h-auto py-0.5"
                    >
                      Inactive
                    </Badge>
                  )}
                </div>
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
                <div className="flex items-center justify-between gap-2" data-testid="directory-card-actions">
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
                        {u.authProvider === 'guest' && (
                          u.status === 'deactivated' ? (
                            <DropdownMenuItem
                              onClick={() => setStatus(u.id, false)}
                              data-testid={`reactivate-${u.id}`}
                            >
                              Reactivate guest
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() => setStatus(u.id, true)}
                              data-testid={`deactivate-${u.id}`}
                            >
                              Disable guest
                            </DropdownMenuItem>
                          )
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
    </>
  );
}
