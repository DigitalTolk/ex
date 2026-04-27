import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { formatRelative, getInitials } from '@/lib/format';

interface UserLookup {
  get(id: string): { displayName: string; avatarURL?: string } | undefined;
}

interface ThreadActionBarProps {
  rootMessageID: string;
  replyCount: number;
  recentReplyAuthorIDs?: string[];
  lastReplyAt?: string;
  onClick: (rootMessageID: string) => void;
  // Optional pre-resolved lookup. The message list hoists a single
  // /users/batch fetch covering every visible author, so passing it in
  // avoids N+1 batch requests across all the thread bars on a busy
  // channel page. Falls back to the bar's own batch when omitted.
  userMap?: UserLookup;
}

export function ThreadActionBar({
  rootMessageID,
  replyCount,
  recentReplyAuthorIDs = [],
  lastReplyAt,
  onClick,
  userMap: providedMap,
}: ThreadActionBarProps) {
  // Skip the batch entirely when the parent supplied a lookup that
  // already covers the recent authors. When some IDs are missing,
  // fetch them and read through the fallback for those specific IDs.
  const missing = recentReplyAuthorIDs.filter(
    (id) => !providedMap || providedMap.get(id) === undefined,
  );
  const fallback = useUsersBatch(missing);
  const userMap: UserLookup = {
    get: (id) => providedMap?.get(id) ?? fallback.map.get(id),
  };

  return (
    <button
      type="button"
      onClick={() => onClick(rootMessageID)}
      data-testid="thread-action-bar"
      aria-label={`View ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
      className="mt-1.5 inline-flex max-w-full items-center gap-2 rounded-md border border-transparent py-1 pl-1 pr-2.5 text-sm hover:border-border hover:bg-muted/60"
    >
      {/* Avatar stack — overlap by negative margin so the row stays
          compact even with three avatars. Most-recent author first
          (matches the order the service writes the slice in). */}
      <span className="flex -space-x-1.5">
        {recentReplyAuthorIDs.map((id) => {
          const u = userMap.get(id);
          return (
            <Avatar
              key={id}
              className="h-6 w-6 rounded-md"
              data-testid={`thread-action-avatar-${id}`}
            >
              {u?.avatarURL && <AvatarImage src={u.avatarURL} alt="" />}
              <AvatarFallback className="rounded-md bg-muted text-[10px] font-medium text-muted-foreground">
                {getInitials(u?.displayName ?? '?')}
              </AvatarFallback>
            </Avatar>
          );
        })}
      </span>
      <span className="font-semibold text-primary">
        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
      </span>
      {lastReplyAt && (
        <span
          data-testid="thread-action-last-reply"
          className="truncate text-muted-foreground"
        >
          Last reply {formatRelative(lastReplyAt)}
        </span>
      )}
    </button>
  );
}
