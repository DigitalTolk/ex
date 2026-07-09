import { describe, it, expect } from 'vitest';
import { buildChannelHref, buildConversationHref } from './message-deeplink';

describe('message-deeplink', () => {
  it('builds plain channel hrefs by slug', () => {
    expect(buildChannelHref('engineering')).toBe('/channel/engineering');
  });

  it('appends the message hash when provided', () => {
    expect(buildChannelHref('engineering', 'msg-123')).toBe(
      '/channel/engineering#msg-msg-123',
    );
  });

  it('appends the thread query and message hash for thread replies', () => {
    expect(buildChannelHref('eng', 'reply-id', 'root-id')).toBe(
      '/channel/eng?thread=root-id#msg-reply-id',
    );
  });

  it('builds plain conversation hrefs by id', () => {
    expect(buildConversationHref('conv-1')).toBe('/conversation/conv-1');
  });

  it('builds thread conversation hrefs', () => {
    expect(buildConversationHref('conv-1', 'm-7', 'root')).toBe(
      '/conversation/conv-1?thread=root#msg-m-7',
    );
  });

  it('url-encodes the thread root id', () => {
    expect(buildConversationHref('conv-1', undefined, 'root with spaces')).toBe(
      '/conversation/conv-1?thread=root%20with%20spaces',
    );
  });
});
