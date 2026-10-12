import { useEffect, useRef } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useLayoutTier } from '@/hooks/useLayoutTier';
import { parseActivityTab } from '@/lib/activity-feed';
import { requestOpenChannels } from '@/lib/mobile-nav';
import { setActivityFilter, setSidebarMode } from '@/stores/sidebar-mode';

// /activity (a bookmark, an old link) opens the Activity list where it lives —
// in the sidebar — on its ?tab=, then goes home: the persistent sidebar on a
// wide window, the compact overlay (opened here) on a narrow one, the list
// screen on a phone.
export default function ActivityPage() {
  const [params] = useSearchParams();
  const tier = useLayoutTier();
  // Read once: the first render's route is the one that asked for Activity.
  const request = useRef({ tab: params.get('tab'), tier });
  useEffect(() => {
    const { tab, tier: atTier } = request.current;
    setSidebarMode('activity');
    if (tab) setActivityFilter(parseActivityTab(tab));
    if (atTier === 'compact') requestOpenChannels();
  }, []);
  return <Navigate to="/" replace />;
}
