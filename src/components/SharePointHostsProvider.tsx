import type { ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import { SharePointHostsContext, useSharePointHostsSetting } from '@/hooks/useSharePoint';

// SharePointHostsProvider hands every message row the hosts whose links are
// shared SharePoint files, read from the workspace settings once per session.
export function SharePointHostsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const hosts = useSharePointHostsSetting(!!user);
  return <SharePointHostsContext.Provider value={hosts}>{children}</SharePointHostsContext.Provider>;
}
