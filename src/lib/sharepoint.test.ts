import { describe, expect, it } from 'vitest';
import { isSharePointHost, isSharePointURL, sharePointOpenURL, sharePointURLs } from './sharepoint';

const HOSTS = ['*.sharepoint.com', 'files.example.com'];

describe('SharePoint links', () => {
  it('matches hosts the way the server does', () => {
    expect(isSharePointHost('Contoso.SharePoint.com', HOSTS)).toBe(true);
    expect(isSharePointHost('files.example.com', HOSTS)).toBe(true);
    expect(isSharePointHost('sharepoint.com', HOSTS)).toBe(false);
    expect(isSharePointHost('evil.example.com', HOSTS)).toBe(false);
  });

  it('takes only https links on those hosts', () => {
    expect(isSharePointURL('https://contoso.sharepoint.com/:w:/s/team/Eabc', HOSTS)).toBe(true);
    expect(isSharePointURL('http://contoso.sharepoint.com/x', HOSTS)).toBe(false);
    expect(isSharePointURL('https://example.org/x', HOSTS)).toBe(false);
    expect(isSharePointURL('not a url', HOSTS)).toBe(false);
    // Sharing off: nothing is a SharePoint link.
    expect(isSharePointURL('https://contoso.sharepoint.com/x', [])).toBe(false);
  });

  it('lists each SharePoint link in a body once, outside code', () => {
    const body =
      'plan https://contoso.sharepoint.com/a, again https://contoso.sharepoint.com/a ' +
      '`https://contoso.sharepoint.com/code` and https://github.com/x';
    expect(sharePointURLs(body, HOSTS)).toEqual(['https://contoso.sharepoint.com/a']);
  });

  it('opens for editing when Office edits the file', () => {
    expect(sharePointOpenURL({ editURL: 'https://e', webURL: 'https://w' }, 'https://l')).toBe('https://e');
    expect(sharePointOpenURL({ webURL: 'https://w' }, 'https://l')).toBe('https://w');
    expect(sharePointOpenURL(undefined, 'https://l')).toBe('https://l');
  });
});
