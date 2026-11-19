import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { apiFetch, getAccessToken } from '@/lib/api';
import { snoozeEnd } from '@/lib/notification-snooze';
import { showToast } from '@/lib/toast';
import type { User } from '@/types';

// A timer can't be set further out than this (a 32-bit count of ms); a longer
// snooze is checked again when this one fires.
const MAX_TIMER_MS = 2 ** 31 - 1;

// useDoNotDisturb is the signed-in user's Do Not Disturb: when it ends (null
// while off), and how to turn it on for some minutes or off (0). The end time
// comes with the user, kept current on every device by the server's settings
// event; a timer flips it off here the moment it runs out.
export function useDoNotDisturb(): { until: Date | null; snooze: (minutes: number) => Promise<void> } {
  const { user, setAuth } = useAuth();
  const [now, setNow] = useState(() => Date.now());
  const until = snoozeEnd(user?.notificationSettings, now);
  const endsAt = until?.getTime();
  useEffect(() => {
    if (endsAt === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(endsAt - Date.now() + 250, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [endsAt, now]);

  const snooze = async (minutes: number) => {
    try {
      const updated = await apiFetch<User>('/api/v1/users/me/notification-snooze', {
        method: 'PUT',
        body: JSON.stringify({ minutes }),
      });
      const token = getAccessToken();
      if (token) setAuth(token, updated);
      setNow(Date.now());
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't change Do Not Disturb", 'error');
    }
  };
  return { until, snooze };
}
