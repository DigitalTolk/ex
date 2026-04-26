import { useNavigate } from 'react-router-dom';
import { MessageSquare, Hash } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useUserThreads, hasUnreadActivity, getSeenMap, type ThreadSummary } from '@/hooks/useThreads';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { formatLongDateTime, slugify } from '@/lib/format';

export default function ThreadsPage() {
  const { data: threads, isLoading } = useUserThreads();
  const { data: userChannels } = useUserChannels();
  const { data: userConvs } = useUserConversations();
  const navigate = useNavigate();

  const seen = getSeenMap();

  const channelName = (id: string) =>
    userChannels?.find((c) => c.channelID === id)?.channelName ?? '';
  const conversationName = (id: string) =>
    userConvs?.find((c) => c.conversationID === id)?.displayName ?? 'Conversation';

  function openThread(t: ThreadSummary) {
    if (t.parentType === 'channel') {
      const slug = slugify(channelName(t.parentID));
      navigate(`/channel/${slug || t.parentID}?thread=${t.threadRootID}`);
    } else {
      navigate(`/conversation/${t.parentID}?thread=${t.threadRootID}`);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-bold mb-1">Threads</h1>
        <p className="text-sm text-muted-foreground mb-4">
          Conversations you've started or replied to.
        </p>

        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        {!isLoading && (threads?.length ?? 0) === 0 && (
          <p className="py-12 text-center text-muted-foreground" data-testid="threads-empty">
            No threads yet — reply to a message to start one.
          </p>
        )}

        <div className="space-y-2">
          {!isLoading && threads?.map((t) => {
            const unread = hasUnreadActivity(t, seen);
            const where =
              t.parentType === 'channel'
                ? `#${channelName(t.parentID) || 'channel'}`
                : conversationName(t.parentID);
            return (
              <button
                key={`${t.parentID}#${t.threadRootID}`}
                data-testid="thread-row"
                onClick={() => openThread(t)}
                className="flex w-full items-start gap-3 rounded-lg border bg-card p-3 text-left hover:bg-muted/40"
              >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  {t.parentType === 'channel' ? (
                    <Hash className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{where}</p>
                    {unread && (
                      <span
                        data-testid="thread-unread"
                        className="h-2 w-2 shrink-0 rounded-full bg-primary"
                        aria-label="New activity"
                      />
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatLongDateTime(t.latestActivityAt)}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {t.rootBody || '(no preview)'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t.replyCount} {t.replyCount === 1 ? 'reply' : 'replies'}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
