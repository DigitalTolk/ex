import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { Globe, Search, MessageSquare } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { fuzzyMatch } from '@/lib/fuzzy';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useBrowseChannels, useJoinChannel, useUserChannels } from '@/hooks/useChannels';
import { useCreateConversation } from '@/hooks/useConversations';
import { useAuth } from '@/context/AuthContext';
import { usePresence } from '@/context/PresenceContext';
import { apiFetch } from '@/lib/api';
import { getInitials } from '@/lib/format';
import type { User } from '@/types';

type Tab = 'channels' | 'members';

function capitalize(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function DirectoriesPage() {
  useDocumentTitle('Directory');
  const [tab, setTab] = useState<Tab>('channels');
  const { user } = useAuth();
  const isAdmin = user?.systemRole === 'admin';

  return (
    <PageContainer title="Directory" description="Browse channels and members in your workspace">
      <div role="tablist" aria-label="Directory sections" className="flex gap-1 border-b">
        <button
          role="tab"
          aria-selected={tab === 'channels'}
          onClick={() => setTab('channels')}
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
          onClick={() => setTab('members')}
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
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search channels..."
          aria-label="Search channels"
          className="pl-9"
        />
      </div>

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
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  // refreshKey is bumped by the WS user.updated bridge below so the
  // members list re-fetches when an avatar / display name changes
  // anywhere in the app.
  const [refreshKey, setRefreshKey] = useState(0);
  const { isOnline } = usePresence();
  const createConversation = useCreateConversation();
  const navigate = useNavigate();

  useEffect(() => {
    const onUpdate = () => setRefreshKey((k) => k + 1);
    window.addEventListener('ex:user-updated', onUpdate);
    return () => window.removeEventListener('ex:user-updated', onUpdate);
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      setError('');
      setIsLoading(true);
    });
    const timer = setTimeout(async () => {
      try {
        const path = query.length >= 2
          ? `/api/v1/users?q=${encodeURIComponent(query)}`
          : `/api/v1/users`;
        const res = await apiFetch<User[]>(path);
        setUsers(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load users');
        setUsers([]);
      } finally {
        setIsLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, refreshKey]);

  async function changeRole(userId: string, newRole: 'admin' | 'member' | 'guest') {
    setError('');
    try {
      await apiFetch(`/api/v1/users/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      });
      // Update local state optimistically
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, systemRole: newRole } : u)),
      );
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
      const newStatus = deactivated ? 'deactivated' : 'active';
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, status: newStatus } : u)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    }
  }

  function handleMessage(userId: string) {
    createConversation.mutate(
      { type: 'dm', participantIDs: [userId] },
      { onSuccess: (conv) => navigate(`/conversation/${conv.id}`) },
    );
  }

  const onlineCount = users.reduce((n, u) => (isOnline(u.id) ? n + 1 : n), 0);

  return (
    <>
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search members..."
          aria-label="Search members"
          className="pl-9"
        />
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive mb-4" role="alert">
          {error}
        </div>
      )}

      {isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {!isLoading && users.map((u) => {
          const online = isOnline(u.id);
          const isSelf = u.id === currentUserId;
          return (
            <div
              key={u.id}
              data-testid="directory-user-card"
              className="group flex items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/40"
            >
              <span className="relative inline-block shrink-0">
                <Avatar className="h-11 w-11">
                  {u.avatarURL && <AvatarImage src={u.avatarURL} alt="" />}
                  <AvatarFallback className="bg-primary/10 text-sm">
                    {getInitials(u.displayName || '??')}
                  </AvatarFallback>
                </Avatar>
                <span
                  data-testid={`presence-${u.id}`}
                  className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ring-2 ring-background ${
                    online ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                  }`}
                  aria-label={online ? 'Online' : 'Offline'}
                />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="font-medium truncate">{u.displayName}</p>
                  {isSelf && (
                    <span className="text-[10px] text-muted-foreground">(you)</span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground truncate">{u.email}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Badge
                    variant={u.systemRole === 'admin' ? 'default' : 'secondary'}
                    data-testid={`role-pill-${u.id}`}
                    className="text-sm h-auto py-0.5"
                  >
                    {capitalize(u.systemRole)}
                  </Badge>
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
              </div>
              <div className="flex flex-col items-end gap-1.5 shrink-0" data-testid="directory-card-actions">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleMessage(u.id)}
                  disabled={createConversation.isPending}
                  aria-label={isSelf ? 'Open notes-to-self' : `Message ${u.displayName}`}
                  className="h-8"
                >
                  <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                  Message
                </Button>
                {isAdmin && !isSelf && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className="inline-flex items-center justify-center rounded-md border border-input bg-background px-2 h-7 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
                      aria-label={`Manage ${u.displayName}`}
                    >
                      Manage
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
          );
        })}
      </div>
    </>
  );
}
