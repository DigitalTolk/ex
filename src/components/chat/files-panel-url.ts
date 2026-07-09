// URL builder for the FilesPanel attachment fetches. Lives outside
// FilesPanel.tsx so the component file stays exclusively
// component-exporting (Vite fast-refresh rule).

export interface FilesPanelEntry {
  attachmentID: string;
  messageID: string;
}

export function attachmentURLForFile(
  entry: FilesPanelEntry,
  parentID: string | undefined,
  parentType: 'channel' | 'conversation' | undefined,
): string {
  const params = new URLSearchParams();
  if (parentID) params.set('parentID', parentID);
  if (parentType) params.set('parentType', parentType);
  if (entry.messageID) params.set('messageID', entry.messageID);
  const qs = params.toString();
  return `/api/v1/attachments/${entry.attachmentID}${qs ? `?${qs}` : ''}`;
}
