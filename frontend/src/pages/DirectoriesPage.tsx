import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hash, Search, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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

export default function DirectoriesPage() {
  const [tab, setTab] = useState<Tab>('channels');
  const { user } = useAuth();
  const isAdmin = user?.systemRole === 'admin';

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl p-6">
        <h1 className="text-xl font-bold mb-1">Directory</h1>
        <p className="text-sm text-muted-foreground mb-4">
          Browse channels and members in your workspace
        </p>

        <div role="tablist" aria-label="Directory sections" className="flex gap-1 border-b mb-4">
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
      </div>
    </div>
  );
}

function ChannelsTab() {
  const { data: allChannels, isLoading } = useBrowseChannels();
  const { data: userChannels } = useUserChannels();
  const joinChannel = useJoinChannel();
  const navigate = useNavigate();

  const joinedIds = new Set(userChannels?.map((c) => c.channelID) ?? []);

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
      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {!isLoading && allChannels?.length === 0 && (
        <p className="py-12 text-center text-muted-foreground">No channels available</p>
      )}

      <div className="space-y-1">
        {allChannels
          ?.filter((ch) => ch.type === 'public')
          .map((channel) => {
            const alreadyJoined = joinedIds.has(channel.id);
            return (
              <div
                key={channel.id}
                className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/50"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Hash className="h-5 w-5 text-muted-foreground" />
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
  const { isOnline } = usePresence();
  const createConversation = useCreateConversation();
  const navigate = useNavigate();

  useEffect(() => {
    // setError/setIsLoading are wrapped in queueMicrotask so the effect
    // doesn't cascade into a synchronous re-render before the timer fires.
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
  }, [query]);

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
        <div className="grid gap-3 sm:grid-cols-2">
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

      <div className="grid gap-3 sm:grid-cols-2">
        {users.map((u) => {
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
                <p className="mt-0.5 text-sm uppercase tracking-wide text-muted-foreground">
                  {u.systemRole}
                </p>
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
                      aria-label={`Change role for ${u.displayName}`}
                    >
                      Role
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
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
