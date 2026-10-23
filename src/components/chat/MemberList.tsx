import { memo, useCallback, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X, UserPlus, ArrowRight } from 'lucide-react';
import { motion } from 'motion/react';
import { UserHoverCard } from '@/components/UserHoverCard';
import { UserAvatar } from '@/components/UserAvatar';
import { UserPickerRow } from '@/components/UserPickerRow';
import { useIsOnline } from '@/stores/presence';
import { useUserLookup } from '@/hooks/useConversations';
import { useAddChannelMembers, useRemoveChannelMember } from '@/hooks/useChannels';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { UserStatusIndicator } from '@/components/UserStatusIndicator';
import { canAddMembers, canRemoveMember, roleNumber, ChannelRole } from '@/lib/roles';
import { useSwipeDismiss } from '@/hooks/useSwipeDismiss';
import { useMobileBackClose } from '@/hooks/useMobileBackClose';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import { usePanelWidth } from '@/hooks/usePanelWidth';
import { MEMBER_LIST_WIDTH } from '@/lib/panel-width';
import { PanelResizeHandle } from '@/components/layout/PanelResizeHandle';
import type { ChannelMembership, UserStatus } from '@/types';
import type { UserMapEntry } from './MessageList';
import { SearchInput } from '@/components/ui/search-input';
import { RIGHT_PANEL_COVER_CLASS } from './right-panel';

interface MemberListProps {
  members: ChannelMembership[];
  channelId?: string;
  /** Slug of the channel — gates the remove affordance (#general never offers it). */
  channelSlug?: string;
  currentUserId?: string;
  currentUserRole?: number;
  userMap?: Record<string, UserMapEntry>;
  onClose?: () => void;
  /** Archived channel: nobody can be added (removing and leaving still work). */
  readOnly?: boolean;
}

interface SearchUser {
  id: string;
  displayName: string;
  email: string;
  avatarURL?: string;
  userStatus?: UserStatus | null;
}

// How long typing must pause before the add-member search asks the server.
const SEARCH_DEBOUNCE_MS = 300;

function roleBadge(role: string | number) {
  const n = roleNumber(role);
  if (n === ChannelRole.Owner) return <Badge variant="secondary" className="text-xs px-1 py-0">Owner</Badge>;
  if (n === ChannelRole.Admin) return <Badge variant="secondary" className="text-xs px-1 py-0">Admin</Badge>;
  return null;
}

export function MemberList({ members, channelId, channelSlug, currentUserId, currentUserRole, userMap, onClose, readOnly }: MemberListProps) {
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const memberIds = useMemo(() => new Set(members.map((m) => m.userID)), [members]);

  // The add-member search: debounced, and one query per term (see
  // useUserLookup), so results always belong to what was last typed. A
  // failed search reads as no results.
  const searchTerm = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const search = useUserLookup(searchTerm, { keepPrevious: true });
  const searching = query.length >= 2;
  const results: SearchUser[] = searching && searchTerm.length >= 2 ? (search.data ?? []) : [];

  // The rail's own scroller hosts the virtualized rows.
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const attachScrollParent = useCallback((node: HTMLDivElement | null) => {
    setScrollParent(node?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null);
  }, []);

  const addMembers = useAddChannelMembers();
  const removeMember = useRemoveChannelMember();
  const removeMemberMutate = removeMember.mutate;

  const handleRemove = useCallback(
    (userId: string) => {
      if (!channelId) return;
      setError('');
      removeMemberMutate(
        { channelId, userId },
        // A silently-failed removal reads as "the button does nothing" — say why.
        { onError: (err) => setError(err instanceof Error ? err.message : 'Failed to remove member') },
      );
    },
    [channelId, removeMemberMutate],
  );

  function handleAdd(user: SearchUser) {
    /* istanbul ignore next -- the picker rows are only rendered when canManage is true, which requires a defined channelId, so handleAdd is never invoked without one; this guard is defensive. */
    if (!channelId) return;
    // The whole row is the add control now — swallow double-clicks while a
    // membership POST is in flight.
    if (pendingId) return;
    setError('');
    setPendingId(user.id);
    addMembers.mutate(
      { channelId, userIds: [user.id] },
      {
        onError: (err) => setError(err instanceof Error ? err.message : 'Failed to add member'),
        onSettled: () => setPendingId(null),
      },
    );
  }

  const canManage = canAddMembers(currentUserRole) && !!channelId && !readOnly;
  const { dismissing, settled, motionProps } = useSwipeDismiss('right', () => onClose?.());
  // Mounted-while-open panel: Back on mobile closes it instead of navigating
  // (no-op when the caller renders it without a close handler).
  useMobileBackClose(true, onClose);
  // And Escape, once nothing above it takes the key.
  useEscapeClose(onClose);
  // Desktop rail is resizable from its left edge, like the side/thread
  // panels; the width persists and resets from profile settings.
  const { width: panelWidth, handleProps: panelHandleProps } = usePanelWidth(
    MEMBER_LIST_WIDTH,
    'left',
    'Resize member list',
  );

  return (
    <motion.div
      className={`relative flex h-full min-h-0 w-[var(--member-list-width,20rem)] flex-col bg-background not-mobile:border-l ${RIGHT_PANEL_COVER_CLASS} mobile:touch-pan-y ${settled ? '' : 'border-l'}`}
      style={{ '--member-list-width': `${panelWidth}px` } as React.CSSProperties}
      data-mobile-right-sidebar="true"
      data-swipe-dismissing={String(dismissing)}
      {...motionProps}
    >
      <PanelResizeHandle edge="left" testID="member-list-resize-handle" {...panelHandleProps} />
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
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {canManage && (
        <div className="border-b p-3 space-y-2">
          <SearchInput
            icon={UserPlus}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Add a member by name or email..."
            aria-label="Add member"
            className="h-9"
          />
          {error && (
            <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive" role="alert">
              {error}
            </div>
          )}
          {results.length > 0 && (
            <div className="border rounded-md max-h-60 overflow-y-auto">
              {/* Canonical people-row (avatar + presence + status), shared
                  with global search, add-member and new-conversation.
                  Clicking a row adds the person; existing members show the
                  standard "Added" badge and stay inert. */}
              {results.map((u) => (
                <SearchResultRow
                  key={u.id}
                  user={u}
                  added={memberIds.has(u.id)}
                  onSelect={() => handleAdd(u)}
                />
              ))}
            </div>
          )}
          {searching && results.length === 0 && searchTerm === query && !search.isFetching && (
            <p className="text-xs text-muted-foreground">No users found</p>
          )}
        </div>
      )}

      <ScrollArea
        className="min-h-0 flex-1"
        scrollbarClassName="opacity-0 transition-opacity data-[scrolling]:opacity-100"
        data-testid="member-list-scroll-area"
      >
        {/* Bottom inset: fixed to the screen bottom on mobile, so the last
            member row must clear the home indicator. */}
        <div ref={attachScrollParent} className="p-2 mobile:pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
          {/* Virtualized: a large channel's rail mounted a row (hover card,
              avatar, status) per member. Each row subscribes to its own
              member's presence, so a presence change re-renders that row
              only — not the whole rail. */}
          {scrollParent && (
            <Virtuoso
              customScrollParent={scrollParent}
              data={members}
              computeItemKey={(_, m) => m.userID}
              increaseViewportBy={400}
              initialItemCount={Math.min(members.length, 40)}
              itemContent={(_, m) => (
                <MemberRow
                  member={m}
                  entry={userMap?.[m.userID]}
                  currentUserId={currentUserId}
                  removable={m.userID !== currentUserId && canRemoveMember(currentUserRole, m.role, channelSlug)}
                  onRemove={handleRemove}
                />
              )}
            />
          )}
        </div>
      </ScrollArea>
    </motion.div>
  );
}

// One member of the rail. Memoized, and subscribed to this member's presence
// alone (the rows used to read the whole online set from their parent).
const MemberRow = memo(function MemberRow({
  member: m,
  entry,
  currentUserId,
  removable,
  onRemove,
}: {
  member: ChannelMembership;
  entry?: UserMapEntry;
  currentUserId?: string;
  removable: boolean;
  onRemove: (userId: string) => void;
}) {
  const avatarURL = entry?.avatarURL;
  const memberOnline = useIsOnline(m.userID);
  return (
    // pb-0.5: the 2px rhythm between rows, inside the row so the virtual
    // list measures it.
    <div className="pb-0.5">
      <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
        <UserHoverCard
          userId={m.userID}
          displayName={m.displayName || 'Unknown'}
          avatarURL={avatarURL}
          userStatus={entry?.userStatus}
          online={memberOnline}
          currentUserId={currentUserId}
          showInlineStatus={false}
        >
          <span className="cursor-pointer">
            <UserAvatar
              displayName={m.displayName || ''}
              avatarURL={avatarURL}
              online={memberOnline}
            />
          </span>
        </UserHoverCard>
        <span className="flex min-w-0 flex-1 items-center gap-1" data-testid={`member-name-status-${m.userID}`}>
          <span className="truncate text-sm">{m.displayName || 'Unknown'}</span>
          <UserStatusIndicator status={entry?.userStatus} />
        </span>
        {roleBadge(m.role)}
        {/* Remove X: visible at rest (muted) on desktop, emphasized on
            row hover — a hover-only reveal reads as "removal is gone".
            Hidden entirely in #general, where the backend rejects
            removal (everyone must stay a member). */}
        {removable && (
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 opacity-100 md:h-6 md:w-6 md:opacity-60 md:group-hover:opacity-100" onClick={() => onRemove(m.userID)} aria-label={`Remove ${m.displayName}`}>
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
});

// A person in the add-member results, with their own presence dot.
function SearchResultRow({ user: u, added, onSelect }: { user: SearchUser; added: boolean; onSelect: () => void }) {
  const online = useIsOnline(u.id);
  return (
    <UserPickerRow
      testID={`member-add-user-${u.id}`}
      displayName={u.displayName}
      email={u.email}
      avatarURL={u.avatarURL}
      online={online}
      userStatus={u.userStatus}
      added={added}
      onSelect={onSelect}
    />
  );
}
