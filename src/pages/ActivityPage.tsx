import { useEffect } from 'react';
import { Inbox } from 'lucide-react';
import { ActivityPanel } from '@/components/activity/ActivityPanel';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useLayoutTier } from '@/hooks/useLayoutTier';
import { setSidebarMode } from '@/stores/sidebar-mode';

// /activity switches the sidebar to Activity. With a persistent sidebar (full
// tier) the list lives there and this page is the "pick something" pane;
// without one (compact window, phone) the page is the list itself.
export default function ActivityPage() {
  useDocumentTitle('Activity');
  const tier = useLayoutTier();

  useEffect(() => {
    setSidebarMode('activity');
  }, []);

  if (tier !== 'full') {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-sidebar pt-2" data-testid="activity-page">
        <ActivityPanel />
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground" data-testid="activity-page">
      <div>
        <Inbox className="mx-auto h-10 w-10 opacity-60" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold text-foreground">Your activity</h1>
        <p className="mt-1 max-w-sm text-sm">
          Mentions, thread replies, DMs, reactions and channel invites land here. Pick one on the left to see it in
          context.
        </p>
      </div>
    </div>
  );
}
