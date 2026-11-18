import { describe, expect, it } from 'vitest';
import { channelEmoji } from './channel-icon';

describe('channelEmoji', () => {
  it('is null for a channel with no icon, so it keeps its globe or lock', () => {
    expect(channelEmoji()).toBeNull();
    expect(channelEmoji('')).toBeNull();
  });

  it('wraps a known emoji name in the colons the server stores it without', () => {
    expect(channelEmoji('rocket')).toBe(':rocket:');
  });

  it('is null for a name ex cannot draw', () => {
    expect(channelEmoji('no_such_emoji_here')).toBeNull();
  });

  it('passes a literal emoji through as it is', () => {
    expect(channelEmoji('\u{1F680}')).toBe('\u{1F680}');
  });
});
