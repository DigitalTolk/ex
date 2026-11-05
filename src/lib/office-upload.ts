import type { QueryClient } from '@tanstack/react-query';
import { getAccessToken } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { WorkspaceSettings } from '@/types';

// Office files in a channel or a DM go to the uploader's OneDrive instead of
// being attached: the message carries the file's link, which shares it with
// the channel's members and shows as its SharePoint card. The server decides
// (internal/service/sharepoint_upload.go); the client only skips asking when
// the answer is surely no, and attaches the file the ordinary way whenever the
// answer is anything but the file's link.

const OFFICE_FILE = /\.(docx?|xlsx?|pptx?)$/i;

export function isOfficeFile(name: string): boolean {
  return OFFICE_FILE.test(name);
}

// What the server answers: the file as it is in OneDrive.
export interface OfficeUpload {
  name: string;
  webURL: string;
  size: number;
}

// Where a file is being added: a channel, or a DM or group DM.
export interface OfficeParent {
  type: 'channel' | 'conversation';
  id: string;
}

// Whether Office files can go to OneDrive at all: SharePoint sharing is on.
// Any channel's or conversation's can — their links share them with the
// members, as a posted link does. Read from the cache when a file is picked —
// never subscribed to — so a composer costs nothing extra to render.
export function keepsOfficeFilesInOneDrive(queryClient: QueryClient): boolean {
  const settings = queryClient.getQueryData<WorkspaceSettings>(queryKeys.workspaceSettings());
  return !!settings?.sharePointHosts?.length;
}

// putOfficeFile sends file to its parent's OneDrive endpoint, reporting how
// much has gone up. Resolves with the file in OneDrive; rejects on any other
// answer, so the caller attaches it instead.
export function putOfficeFile(parent: OfficeParent, file: File, onProgress: (fraction: number) => void): Promise<OfficeUpload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const base = parent.type === 'channel' ? 'channels' : 'conversations';
    xhr.open('PUT', `/api/v1/${base}/${encodeURIComponent(parent.id)}/office-files?name=${encodeURIComponent(file.name)}`);
    const token = getAccessToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const up = xhr.response as OfficeUpload | null;
      if (xhr.status === 201 && up?.webURL) resolve(up);
      else reject(new Error(`OneDrive upload refused (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('OneDrive upload failed'));
    xhr.send(file);
  });
}

// The file as a link in the message: its name as the text, both escaped so a
// bracket or parenthesis in either can't break the link.
export function officeFileLink(up: OfficeUpload): string {
  const text = up.name.replace(/[[\]\\]/g, (c) => `\\${c}`);
  const url = up.webURL.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
  return `[${text}](${url})`;
}

// What a composer's text and chips send: the attachments by id, and each
// OneDrive file's link (its chip's `link`) on a line after the text — the
// composer edits raw markdown, so the link only joins the text on its way out.
export function composerValue(body: string, chips: readonly { id: string; link?: string }[]): { body: string; attachmentIDs: string[] } {
  const links = chips.flatMap((c) => (c.link ? [c.link] : []));
  return {
    body: [body, ...links].filter((s) => s !== '').join('\n'),
    attachmentIDs: chips.filter((c) => !c.link).map((c) => c.id),
  };
}
