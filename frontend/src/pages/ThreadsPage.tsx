import { PageContainer } from '@/components/layout/PageContainer';
import { Skeleton } from '@/components/ui/skeleton';
import { useUserThreads, threadDeepLink } from '@/hooks/useThreads';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useAuth } from '@/context/AuthContext';
import { ThreadCard } from '@/components/threads/ThreadCard';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

export default function ThreadsPage() {
  useDocumentTitle('Threads');
  const { data: threads, isLoading } = useUserThreads();
  const { data: userChannels } = useUserChannels();
  const { data: userConvs } = useUserConversations();
  const { user } = useAuth();

  const channelName = (id: string) =>
    userChannels?.find((c) => c.channelID === id)?.channelName ?? '';
  const conversationName = (id: string) =>
    userConvs?.find((c) => c.conversationID === id)?.displayName ?? 'Conversation';

  return (
    <PageContainer
      title="Threads"
      description="Conversations you've started or replied to."
    >
      {isLoading && (
        <div className="space-y-3" data-testid="threads-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      )}

      {!isLoading && (threads?.length ?? 0) === 0 && (
        <p
          className="py-12 text-center text-muted-foreground"
          data-testid="threads-empty"
        >
          No threads yet — reply to a message to start one.
        </p>
      )}

      <div className="space-y-4">
        {!isLoading &&
          threads?.map((t) => {
            const where =
              t.parentType === 'channel'
                ? `~${channelName(t.parentID) || 'channel'}`
                : conversationName(t.parentID);
            return (
              <ThreadCard
                key={`${t.parentID}#${t.threadRootID}`}
                summary={t}
                title={where}
                deepLink={threadDeepLink(t, channelName(t.parentID))}
                currentUserId={user?.id}
              />
            );
          })}
      </div>
    </PageContainer>
  );
}
