import { memo, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { PopoverPortal } from '@/components/PopoverPortal';
import { useAllUsers } from '@/hooks/useConversations';
import { useMyUserGroupIds, useUserGroup } from '@/hooks/useUserGroups';
import { getInitials } from '@/lib/format';

// How many member avatars the card shows before "+N".
const SHOWN_MEMBERS = 8;

interface Props {
  groupId: string;
  handle: string;
  // The viewer: the pill is highlighted when they belong to the group.
  currentUserId?: string;
  // The pill, highlighted or not.
  children: (mine: boolean) => ReactNode;
}

// UserGroupMentionCard renders an "@oncall" pill — highlighted for the
// group's members — and opens a card with the group's name, description and
// members, and a link to the group in the directory, when clicked. It mounts
// only for a message that mentions a group, so other messages look nothing
// up; the group itself is fetched only while the card is open.
function UserGroupMentionCardImpl({ groupId, handle, currentUserId, children }: Props) {
  const mine = useMyUserGroupIds(currentUserId).has(groupId);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span
        ref={triggerRef}
        className="inline cursor-pointer align-baseline"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {children(mine)}
      </span>
      <PopoverPortal
        open={open}
        triggerRef={triggerRef}
        onDismiss={() => setOpen(false)}
        estimatedHeight={180}
        estimatedWidth={288}
        preferredSide="bottom"
        preferredAlign="start"
        role="dialog"
        ariaLabel={`@${handle}`}
        mobileSheet
        className="w-72 rounded-md border bg-popover p-3 shadow-lg touch:w-screen touch:max-w-none touch:rounded-b-none touch:rounded-t-xl touch:border-b-0 touch:pb-[calc(var(--sheet-safe-bottom,env(safe-area-inset-bottom))+0.75rem)]"
      >
        {open ? <UserGroupMentionCardContent groupId={groupId} handle={handle} onClose={() => setOpen(false)} /> : null}
      </PopoverPortal>
    </>
  );
}

export const UserGroupMentionCard = memo(UserGroupMentionCardImpl);

function UserGroupMentionCardContent({ groupId, handle, onClose }: { groupId: string; handle: string; onClose: () => void }) {
  const { data: group, isLoading } = useUserGroup(groupId);
  const { data: users = [] } = useAllUsers();
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading @{handle}…</p>;
  }
  if (!group || group.disabled) {
    return <p className="text-sm text-muted-foreground">@{handle} is no longer available.</p>;
  }
  const members = group.memberIds ?? [];
  const shown = members.slice(0, SHOWN_MEMBERS);
  return (
    <div data-testid="usergroup-card">
      <p className="text-sm font-semibold">@{group.handle}</p>
      <p className="text-sm text-secondary-foreground">{group.name}</p>
      {group.description && <p className="mt-1 text-sm text-muted-foreground">{group.description}</p>}
      <div className="mt-3 flex items-center gap-1" aria-label={`${members.length} members`}>
        {shown.map((id) => {
          const u = byId.get(id);
          const name = u?.displayName ?? id;
          return (
            <Avatar key={id} className="h-7 w-7" title={name}>
              {u?.avatarURL && <AvatarImage src={u.avatarURL} alt="" />}
              <AvatarFallback className="bg-primary/10 text-xs">{getInitials(name)}</AvatarFallback>
            </Avatar>
          );
        })}
        {members.length > SHOWN_MEMBERS && (
          <span className="text-xs text-muted-foreground">+{members.length - SHOWN_MEMBERS}</span>
        )}
        {members.length === 0 && <span className="text-sm text-muted-foreground">No members yet</span>}
      </div>
      <Link
        to={`/directory/groups?group=${encodeURIComponent(group.id)}`}
        onClick={onClose}
        className="mt-3 inline-block text-sm font-medium text-foreground underline-offset-2 hover:underline"
      >
        View group
      </Link>
    </div>
  );
}
