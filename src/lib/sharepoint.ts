import { extractURLs } from '@/lib/format';

// SharePoint links. The workspace settings name the hosts whose links are
// shared SharePoint files; "*.example.com" matches every subdomain. The rule
// and the link extraction match the server's (internal/service/sharepoint.go),
// so the link a card asks about is the link the server shared.

export function isSharePointHost(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((entry) => (entry.startsWith('*.') ? h.endsWith(entry.slice(1)) : h === entry));
}

export function isSharePointURL(raw: string, hosts: readonly string[]): boolean {
  if (hosts.length === 0) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && isSharePointHost(url.hostname, hosts);
  } catch {
    return false;
  }
}

// The distinct SharePoint links in a message body, outside code.
export function sharePointURLs(body: string, hosts: readonly string[]): string[] {
  return [...new Set(extractURLs(body).filter((u) => isSharePointURL(u, hosts)))];
}

// Where a SharePoint link opens: Office for the web's editor when Office
// edits the file, else the file in SharePoint, else the link as posted.
export function sharePointOpenURL(file: { editURL?: string; webURL: string } | undefined, link: string): string {
  return file?.editURL || file?.webURL || link;
}
