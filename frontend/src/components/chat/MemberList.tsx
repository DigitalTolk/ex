import { useState, useEffect, useMemo } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X, Check, UserPlus } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { getInitials } from '@/lib/format';
import { useQueryClient } from '@tanstack/react-query';
import { UserHoverCard } from '@/components/UserHoverCard';
import { UserAvatar } from '@/components/UserAvatar';
import { canManageMembers, canRemoveMember, roleNumber, ChannelRole } from '@/lib/roles';
import type { ChannelMembership } from '@/types';
import type { UserMapEntry } from './MessageList';

interface MemberListProps {
  members: ChannelMembership[];
  channelId?: string;
  currentUserId?: string;
  currentUserRole?: number;
  userMap?: Record<string, UserMapEntry>;
  onClose?: () => void;
}

interface SearchUser {
  id: string;
  displayName: string;
  email: string;
  avatarURL?: string;
}

function roleBadge(role: string | number) {
  const n = roleNumber(role);
  if (n === ChannelRole.Owner) return <Badge variant="secondary" className="text-[10px] px-1 py-0">Owner</Badge>;
  if (n === ChannelRole.Admin) return <Badge variant="secondary" className="text-[10px] px-1 py-0">Admin</Badge>;
  return null;
}

export function MemberList({ members, channelId, currentUserId, currentUserRole, userMap, onClose }: MemberListProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchUser[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const memberIds = useMemo(() => new Set(members.map((m) => m.userID)), [members]);

  useEffect(() => {
    if (query.length < 2) {
      // Defer the clear so we don't trigger a synchronous re-render from
      // inside the effect body — the setTimeout(0) is the standard pattern
      // the lint rule recommends here.
      const t = setTimeout(() => setResults([]), 0);
      return () => clearTimeout(t);
    }
    const timer = setTimeout(async () => {
      try {
        const users = await apiFetch<SearchUser[]>(
          `/api/v1/users?q=${encodeURIComponent(query)}`,
        );
        setResults(users);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  async function handleRemove(userId: string) {
    if (!channelId) return;
    await apiFetch(`/api/v1/channels/${channelId}/members/${userId}`, { method: 'DELETE' });
    queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers(channelId) });
  }

  async function handleAdd(user: SearchUser) {
    if (!channelId) return;
    setError('');
    setPendingId(user.id);
    try {
      await apiFetch(`/api/v1/channels/${channelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userID: user.id, role: 'member' }),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers(channelId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setPendingId(null);
    }
  }

  const canManage = canManageMembers(currentUserRole) && !!channelId;

  return (
    <div className="w-80 border-l flex h-full min-h-0 flex-col">
      <div className="px-4 py-3 border-b flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Members</h2>
          <p className="text-xs text-muted-foreground">{members.length} member{members.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onClose}
              aria-label="Close member list"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {canManage && (
        <div className="border-b p-3 space-y-2">
          <div className="relative">
            <UserPlus className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Add a member by name or email..."
              aria-label="Add member"
              className="pl-8 h-9"
            />
          </div>
          {error && (
            <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive" role="alert">
              {error}
            </div>
          )}
          {results.length > 0 && (
            <div className="border rounded-md max-h-60 overflow-y-auto">
              {results.map((u) => {
                const alreadyMember = memberIds.has(u.id);
                return (
                  <div
                    key={u.id}
                    className="flex items-center gap-2 px-2 py-1.5 text-sm border-b last:border-b-0"
                  >
                    <Avatar className="h-6 w-6 shrink-0">
                      {u.avatarURL && <AvatarImage src={u.avatarURL} alt="" />}
                      <AvatarFallback className="bg-primary/10 text-[10px]">
                        {getInitials(u.displayName || '??')}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="truncate">{u.displayName}</p>
                      <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                    </div>
                    {alreadyMember ? (
                      <span
                        className="flex h-7 w-7 items-center justify-center text-emerald-600"
                        aria-label="Already a member"
                        title="Already a member"
                      >
                        <Check className="h-4 w-4" />
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleAdd(u)}
                        disabled={pendingId === u.id}
                        aria-label={`Add ${u.displayName}`}
                      >
                        {pendingId === u.id ? 'Adding...' : 'Add'}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {query.length >= 2 && results.length === 0 && (
            <p className="text-xs text-muted-foreground">No users found</p>
          )}
        </div>
      )}

      <ScrollArea
        className="min-h-0 flex-1"
        scrollbarClassName="opacity-0 transition-opacity data-[scrolling]:opacity-100"
        data-testid="member-list-scroll-area"
      >
        <div className="p-2 space-y-0.5">
          {members.map((m) => {
            const entry = userMap?.[m.userID];
            const avatarURL = entry?.avatarURL;
            const online = entry?.online;
            return (
              <div key={m.userID} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
                <UserHoverCard
                  userId={m.userID}
                  displayName={m.displayName || 'Unknown'}
                  avatarURL={avatarURL}
                  online={online}
                  currentUserId={currentUserId}
                >
                  <span className="cursor-pointer">
                    <UserAvatar
                      displayName={m.displayName || ''}
                      avatarURL={avatarURL}
                      online={online}
                    />
                  </span>
                </UserHoverCard>
                <span className="text-sm truncate flex-1">{m.displayName || 'Unknown'}</span>
                {roleBadge(m.role)}
                {m.userID !== currentUserId && canRemoveMember(currentUserRole, m.role) && (
                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100" onClick={() => handleRemove(m.userID)} aria-label={`Remove ${m.displayName}`}>
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
