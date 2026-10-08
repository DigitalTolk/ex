import { useIsFetching, type Query } from '@tanstack/react-query';

// What a person waits on after opening a chat or thread: the chat itself and
// its messages. Only a first load counts (nothing on screen yet), not a
// refresh of something already showing.
const PAGE_CONTENT = new Set(['channelBySlug', 'channelMessages', 'conversation', 'conversationMessages', 'thread']);

function isPageContentLoading(query: Query): boolean {
  return query.state.data === undefined && PAGE_CONTENT.has(String(query.queryKey[0]));
}

// LoadingBar is a thin line along the top of the content pane while the page
// a person opened is still loading. It fades in only after a moment, so a
// quick load never shows it, and takes no space.
export function LoadingBar() {
  const loading = useIsFetching({ predicate: isPageContentLoading }) > 0;
  return (
    <div className="pointer-events-none relative z-20 h-0 shrink-0">
      <div
        role={loading ? 'progressbar' : undefined}
        aria-label={loading ? 'Loading' : undefined}
        aria-hidden={!loading}
        data-testid="loading-bar"
        data-loading={loading}
        className={`absolute inset-x-0 top-0 h-0.5 overflow-hidden transition-opacity duration-200 ${loading ? 'opacity-100 delay-300' : 'opacity-0'}`}
      >
        <div
          className={`h-full w-1/3 rounded-full bg-brand animate-loading-bar motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-60 ${loading ? '' : '[animation-play-state:paused]'}`}
        />
      </div>
    </div>
  );
}
