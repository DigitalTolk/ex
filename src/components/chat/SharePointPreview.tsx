import type { ReactNode } from 'react';
import { useSharePointPreview, type SharePointParent } from '@/hooks/useSharePoint';

interface SharePointPreviewProps {
  parent: SharePointParent;
  fileID: string;
  title: string;
  // Shown instead when the file can't be previewed (no sign-in of the
  // viewer's, no access, Microsoft 365 unavailable).
  fallback: ReactNode;
}

// The frame may do all Office needs — run, keep its sign-in, submit, open its
// own windows ("Open in desktop app") and downloads, show its dialogs — but
// never navigate the page it sits in: no allow-top-navigation. Without the
// sandbox, Microsoft's "Access denied" OK sent the whole of ex to
// microsoft.com; whatever the frame loads or is redirected to, it can only
// ever change itself. (The file is on Microsoft's origin, not ours, so
// allow-same-origin doesn't let it lift the sandbox from our page.)
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals';

// SharePointPreview shows a shared file in the lightbox as it is: Office for
// the web's viewer (SharePoint's, for other files), framed from the address
// the server fetched as the viewer, kept inside the lightbox.
export function SharePointPreview({ parent, fileID, title, fallback }: SharePointPreviewProps) {
  const { data: url, isError } = useSharePointPreview(parent, fileID);
  if (isError) return fallback;
  if (!url) return <p className="text-center text-sm text-white/70">Loading…</p>;
  return (
    <iframe
      src={url}
      title={title}
      allow="fullscreen"
      sandbox={SANDBOX}
      referrerPolicy="strict-origin-when-cross-origin"
      data-testid="sharepoint-preview"
      className="h-full w-full rounded-md border-0 bg-background"
    />
  );
}
