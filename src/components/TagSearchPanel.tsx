import { Skeleton } from '@/components/ui/skeleton';
import { SidePanel } from '@/components/chat/SidePanel';
import { useTagState } from '@/context/TagSearchContext';
import { useSearchMessages } from '@/hooks/useSearch';
import { MessageHitCard } from '@/components/search/MessageHitCard';

// Inline right-rail panel — same `SidePanel` shell as Pinned/Files/
// Members/Thread so it lays out as a true sidebar. Mounted by
// Channel/ConversationView, not AppLayout: when active it replaces
// whichever other panel was open.
export function TagSearchPanel() {
  const { activeTag, tagNonce, closeTag } = useTagState();
  // tagNonce participates in the query key so re-clicking the same
  // hashtag re-fires the search instead of returning cached results.
  const messages = useSearchMessages(
    activeTag ? `#${activeTag}` : '',
    !!activeTag,
    50,
    undefined,
    tagNonce,
  );

  if (!activeTag) return null;

  const hits = messages.data?.hits ?? [];
  return (
    <SidePanel
      title={`Tagged: ${activeTag}`}
      ariaLabel={`Messages tagged ${activeTag}`}
      closeLabel="Close tag search"
      onClose={closeTag}
    >
      {messages.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {messages.isError && !messages.isLoading && (
        <p className="p-2 text-sm text-destructive" role="alert">
          {messages.error instanceof Error ? messages.error.message : 'Search failed'}
        </p>
      )}
      {!messages.isLoading && !messages.isError && hits.length === 0 && (
        <p className="p-2 text-sm text-muted-foreground">
          No messages tagged{' '}
          <code className="rounded bg-muted px-1">#{activeTag}</code>.
        </p>
      )}
      <div className="space-y-2" data-testid="tag-search-panel">
        {hits.map((h) => (
          <MessageHitCard key={h.id} hit={h} />
        ))}
      </div>
    </SidePanel>
  );
}
