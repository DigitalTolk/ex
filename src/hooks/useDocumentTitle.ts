import { useEffect } from 'react';
import { formatDocumentTitle, useDocumentNotificationCount } from '@/lib/document-title';

// Sets `document.title` to "<page> · ex" while the calling component is
// mounted. Pass null/undefined to use just the bare app name (the index
// route does this).
export function useDocumentTitle(page: string | null | undefined): void {
  const notificationCount = useDocumentNotificationCount();

  useEffect(() => {
    document.title = formatDocumentTitle(page, notificationCount);
  }, [notificationCount, page]);
}
