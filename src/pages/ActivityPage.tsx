import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Clock3, X } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { UserHoverCard } from '@/components/UserHoverCard';
import { useActivity, useCancelReminder, useMarkActivityRead, useReminders } from '@/hooks/useActivity';
import { useUserChannels } from '@/hooks/useChannels';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useEmojiMap } from '@/hooks/useEmoji';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useAuth } from '@/context/AuthContext';
import { buildChannelHref, buildConversationHref } from '@/lib/message-deeplink';
import { formatLongDateTime, formatRelative, slugify } from '@/lib/format';
import type { ActivityItem, Reminder } from '@/types';

export default function ActivityPage() {
  useDocumentTitle('Activity');
  const { data: feed, isLoading } = useActivity();
  const { data: reminders } = useReminders();
  const { data: channels } = useUserChannels();
  const markRead = useMarkActivityRead();
  const cancelReminder = useCancelReminder();
  const { data: emojiMap } = useEmojiMap();
  const { user } = useAuth();

  const items = useMemo(() => feed?.items ?? [], [feed]);

  // Resolve reactor display names in one batch.
  const actorIDs = useMemo(
    () => items.filter((i) => i.type === 'reaction' && i.actorID).map((i) => i.actorID as string),
    [items],
  );
  const { map: userMap } = useUsersBatch(actorIDs);

  // Viewing the page clears the unread badge.
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    markReadMutate();
  }, [markReadMutate]);

  // channelID → slug, built once from the channel cache so each row's deep link
  // is an O(1) lookup instead of a linear scan per render.
  const channelSlugByID = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of channels ?? []) m.set(c.channelID, slugify(c.channelName));
    return m;
  }, [channels]);

  const hrefFor = (i: ActivityItem | Reminder) => {
    if (i.parentType !== 'channel') return buildConversationHref(i.parentID, i.messageID);
    // Prefer the item's own slug snapshot, else the channel cache, else the id.
    const slug = i.channelSlug || channelSlugByID.get(i.parentID) || i.parentID;
    return buildChannelHref(slug, i.messageID);
  };

  const pending = reminders ?? [];

  return (
    <PageContainer title="Activity" description="Reactions to your messages and reminders.">
      {pending.length > 0 && (
        <section className="mb-6" data-testid="pending-reminders">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Scheduled reminders
          </h2>
          <div className="space-y-2">
            {pending.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
                data-testid="pending-reminder"
              >
                <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <Link
                  to={hrefFor(r)}
                  className="min-w-0 flex-1 truncate text-sm transition-colors hover:text-muted-foreground"
                >
                  {r.messagePreview || 'A message'}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatLongDateTime(r.remindAt)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Cancel reminder"
                  data-testid="cancel-reminder"
                  onClick={() => cancelReminder.mutate(r.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {isLoading && (
        <div className="space-y-3" data-testid="activity-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <p className="py-12 text-center text-muted-foreground" data-testid="activity-empty">
          No activity yet.
        </p>
      )}

      <div className="space-y-2">
        {items.map((item) => {
          // A reaction row carries a clickable author (hover card), so the row
          // can't be a single anchor (a button can't nest in an <a>): the author
          // is a sibling hover card and the preview is the message link. A
          // reminder row has no author, so the whole row stays a link.
          if (item.type === 'reaction') {
            const actor = userMap.get(item.actorID ?? '');
            return (
              <div
                key={item.id}
                className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
                data-testid="activity-item"
              >
                <span className="mt-0.5 shrink-0">
                  <EmojiGlyph emoji={item.emoji ?? ''} customMap={emojiMap} size="lg" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">
                    {item.actorID ? (
                      <UserHoverCard
                        userId={item.actorID}
                        displayName={actor?.displayName ?? 'Someone'}
                        avatarURL={actor?.avatarURL}
                        userStatus={actor?.userStatus}
                        online={actor?.online}
                        currentUserId={user?.id}
                        triggerClassName="font-semibold cursor-pointer"
                      >
                        {actor?.displayName ?? 'Someone'}
                      </UserHoverCard>
                    ) : (
                      <span className="font-semibold">Someone</span>
                    )}{' '}
                    reacted to your message
                  </span>
                  <Link
                    to={hrefFor(item)}
                    className="mt-0.5 block truncate text-sm text-muted-foreground transition-colors hover:text-foreground"
                    data-testid="activity-link"
                  >
                    {item.messagePreview || 'View message'}
                  </Link>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelative(item.createdAt)}
                </span>
              </div>
            );
          }
          return (
            <Link
              key={item.id}
              to={hrefFor(item)}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 hover:bg-muted"
              data-testid="activity-item"
            >
              <span className="mt-0.5 shrink-0" aria-hidden="true">
                <Bell className="h-4 w-4 text-pinned" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">Reminder</span>
                {item.messagePreview && (
                  <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                    {item.messagePreview}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatRelative(item.createdAt)}
              </span>
            </Link>
          );
        })}
      </div>
    </PageContainer>
  );
}
