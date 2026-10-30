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

// SharePointPreview shows a shared file in the lightbox as it is: Office for
// the web's viewer (SharePoint's, for other files), framed from the address
// the server fetched as the viewer.
export function SharePointPreview({ parent, fileID, title, fallback }: SharePointPreviewProps) {
  const { data: url, isError } = useSharePointPreview(parent, fileID);
  if (isError) return fallback;
  if (!url) return <p className="text-center text-sm text-white/70">Loading…</p>;
  return (
    <iframe
      src={url}
      title={title}
      allow="fullscreen"
      data-testid="sharepoint-preview"
      className="h-full w-full rounded-md border-0 bg-background"
    />
  );
}
