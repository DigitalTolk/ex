import { Bell, BellOff, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNotifications } from '@/context/NotificationContext';
import { useEffect, useState } from 'react';

const DISMISS_KEY = 'ex.notifications.prompt.dismissed.v1';

// Inline banner asking the user to grant browser notification permission.
// Only renders when permission is still 'default' AND the user has not
// dismissed the prompt this session — once dismissed, we wait until the
// next session before re-asking. Granted/denied/unsupported all hide it.
export function NotificationPrompt() {
  const { permission, requestPermission } = useNotifications();
  const [dismissed, setDismissed] = useState(() => {
    if (typeof sessionStorage === 'undefined') return false;
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  });

  useEffect(() => {
    if (typeof sessionStorage === 'undefined') return;
    if (dismissed) sessionStorage.setItem(DISMISS_KEY, '1');
  }, [dismissed]);

  if (permission !== 'default' || dismissed) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2 text-sm"
    >
      <Bell className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1">
        Get desktop notifications when you receive new messages.
      </span>
      <Button
        size="sm"
        variant="default"
        onClick={() => requestPermission()}
        aria-label="Enable browser notifications"
      >
        Enable
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss notification prompt"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
      <BellOff className="hidden" aria-hidden />
    </div>
  );
}
