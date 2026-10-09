import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { formatRelative, getInitials } from '@/lib/format';

interface UserLookup {
  get(id: string): { displayName: string; avatarURL?: string } | undefined;
}

// Sentinel author of channel webhook posts (service.WebhookAuthorID). It is
// not a user, so it is never looked up; it shows the webhook root's identity.
const WEBHOOK_AUTHOR_ID = 'webhook';
const WEBHOOK_FALLBACK = { displayName: 'Webhook' };

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
  // The thread has replies the user hasn't read (the same thread the
  // sidebar dot and the Threads count point at).
  hasNew?: boolean;
  // Name and avatar of a webhook root, shown for webhook replies. The server
  // only accepts a webhook reply under a root with the same author, so a
  // sentinel reply always sits under a webhook root.
  webhookAuthor?: { displayName: string; avatarURL?: string };
}

export function ThreadActionBar({
  rootMessageID,
  replyCount,
  recentReplyAuthorIDs = [],
  lastReplyAt,
  onClick,
  userMap: providedMap,
  hasNew = false,
  webhookAuthor,
}: ThreadActionBarProps) {
  // Skip the batch entirely when the parent supplied a lookup that
  // already covers the recent authors. When some IDs are missing,
  // fetch them and read through the fallback for those specific IDs.
  const missing = recentReplyAuthorIDs.filter(
    (id) => id !== WEBHOOK_AUTHOR_ID && (!providedMap || providedMap.get(id) === undefined),
  );
  const fallback = useUsersBatch(missing);
  const userMap: UserLookup = {
    get: (id) =>
      id === WEBHOOK_AUTHOR_ID
        ? webhookAuthor ?? WEBHOOK_FALLBACK
        : providedMap?.get(id) ?? fallback.map.get(id),
  };

  return (
    <button
      type="button"
      onClick={() => onClick(rootMessageID)}
      data-testid="thread-action-bar"
      data-new={hasNew ? 'true' : undefined}
      aria-label={`View ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}${hasNew ? ', new replies' : ''}`}
      className="mt-1.5 inline-flex max-w-full items-center gap-2 rounded-md border border-transparent py-1 pl-1 pr-2.5 text-xs hover:border-border hover:bg-muted/60"
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
              <AvatarFallback className="rounded-md text-[10px] font-medium">
                {getInitials(u?.displayName ?? '?')}
              </AvatarFallback>
            </Avatar>
          );
        })}
      </span>
      <span className="shrink-0 whitespace-nowrap font-semibold text-primary">
        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
      </span>
      {hasNew && (
        <span
          data-testid="thread-action-new"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
          role="img"
          aria-label="New replies"
          title="New replies"
        />
      )}
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
