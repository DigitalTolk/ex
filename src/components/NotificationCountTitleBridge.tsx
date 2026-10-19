import { useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useActivityUnread } from '@/hooks/useActivity';
import { setDocumentNotificationCount } from '@/lib/document-title';

// The tab title's count — and so the app icon's — is the Activity bell's.
// Every alert has its Activity row (mentions, DMs, thread replies, alerting
// "All messages" channel messages, channel adds, due reminders), so one number
// says what is waiting wherever it is shown, and a desktop or phone app
// reading the title shows the same number as the bell.
export function NotificationCountTitleBridge() {
  const { isAuthenticated } = useAuth();
  const unread = useActivityUnread(isAuthenticated);
  const count = isAuthenticated ? unread : 0;

  useEffect(() => {
    setDocumentNotificationCount(count);
  }, [count]);

  useEffect(() => () => setDocumentNotificationCount(0), []);

  return null;
}
