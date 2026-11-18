import { useAuth } from '@/context/AuthContext';
import { apiFetch, getAccessToken } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { localTimeZone } from '@/lib/user-time';
import type { User } from '@/types';

// useClearStatus clears the signed-in user's custom status in place, without
// opening the status dialog: the ✕ beside the status in the sidebar and in
// the account menu.
export function useClearStatus(): () => Promise<void> {
  const { setAuth } = useAuth();
  return async () => {
    try {
      const updated = await apiFetch<User>('/api/v1/users/me/status', {
        method: 'DELETE',
        body: JSON.stringify({ timeZone: localTimeZone() }),
      });
      const token = getAccessToken();
      if (token) setAuth(token, updated);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to clear status', 'error');
    }
  };
}
