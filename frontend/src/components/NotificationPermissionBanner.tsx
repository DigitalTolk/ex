import { useState } from 'react';
import { Bell, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/Banner';
import { useNotifications } from '@/context/NotificationContext';
import { useAuth } from '@/context/AuthContext';
import { readString, writeString } from '@/lib/storage';

const DISMISS_KEY = 'ex.notifications.banner.dismissed.v1';

const readDismissed = () => readString(DISMISS_KEY) === '1';
const writeDismissed = () => writeString(DISMISS_KEY, '1');

// Required because Safari and Firefox only honor requestPermission()
// inside a user-gesture handler — auto-prompting on mount silently fails
// there. Once the user answers (granted or denied) we don't re-ask;
// browsers gate re-prompts behind site settings anyway.
export function NotificationPermissionBanner() {
  const { permission, requestPermission, prefs } = useNotifications();
  const { isAuthenticated } = useAuth();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [busy, setBusy] = useState(false);

  if (!isAuthenticated || dismissed || !prefs.browserEnabled || permission !== 'default') {
    return null;
  }

  const dismiss = () => {
    writeDismissed();
    setDismissed(true);
  };

  const enable = async () => {
    setBusy(true);
    try {
      const result = await requestPermission();
      // Stop nagging once the user has answered — browsers won't let us
      // re-prompt anyway. Only "default" (closed without choosing) lets
      // the banner stick around.
      if (result !== 'default') {
        writeDismissed();
        setDismissed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Banner
      tone="info"
      testId="notification-permission-banner"
      icon={<Bell className="h-4 w-4" aria-hidden="true" />}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={enable}
            disabled={busy}
            data-testid="notification-permission-enable"
          >
            {busy ? 'Asking…' : 'Enable'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={dismiss}
            aria-label="Dismiss"
            data-testid="notification-permission-dismiss"
          >
            <X className="h-4 w-4" />
          </Button>
        </>
      }
    >
      Enable browser notifications to get pinged about new messages and mentions, even when ex is in the background.
    </Banner>
  );
}
