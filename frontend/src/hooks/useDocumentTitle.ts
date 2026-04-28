import { useEffect } from 'react';

const APP_NAME = 'ex';

// Sets `document.title` to "<page> · ex" while the calling component is
// mounted. Pass null/undefined to use just the bare app name (the index
// route does this).
export function useDocumentTitle(page: string | null | undefined): void {
  useEffect(() => {
    document.title = page ? `${page} · ${APP_NAME}` : APP_NAME;
  }, [page]);
}
