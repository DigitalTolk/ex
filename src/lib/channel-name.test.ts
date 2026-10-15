import { describe, expect, it } from 'vitest';
import { channelName, channelNameDraft } from './channel-name';
import { CHANNEL_NAME_PATTERN } from './limits';

describe('channelName', () => {
  it.each([
    ['Marketing Team', 'marketing-team'],
    ['  Q3   Planning  ', 'q3-planning'],
    ['R&D', 'r-and-d'],
    ['v1.2 release', 'v1-2-release'],
    ['foo_bar/baz', 'foo-bar-baz'],
    ['Café', 'cafe'],
    ['Привет мир', 'privet-mir'],
    ['JavaScript', 'javascript'],
    ['--team--', 'team'],
  ])('turns %j into %j', (typed, want) => {
    expect(channelName(typed)).toBe(want);
    expect(want).toMatch(CHANNEL_NAME_PATTERN);
  });

  it('drops the dots of ä, ö and ü, except in German', () => {
    for (const locale of [undefined, 'en-US', 'sv-SE', 'fi', 'tr']) {
      expect(channelName('Försäljning Zürich', locale)).toBe('forsaljning-zurich');
    }
    expect(channelName('Försäljning Zürich', 'de')).toBe('foersaeljning-zuerich');
    expect(channelName('Försäljning Zürich', 'de-CH')).toBe('foersaeljning-zuerich');
    // A tag that only starts with "de" is another language.
    expect(channelName('Zürich', 'del')).toBe('zurich');
  });

  it('follows the other rules of the locale', () => {
    expect(channelName('Ålands Øl', 'en')).toBe('alands-ol');
    expect(channelName('Ålands Øl', 'da')).toBe('aalands-oel');
  });

  it('has nothing for text without Latin letters, digits or a transliteration', () => {
    expect(channelName('日本')).toBe('');
    expect(channelName(' - ')).toBe('');
  });
});

describe('channelNameDraft', () => {
  it('keeps a word just ended as a trailing hyphen, so the next word can follow', () => {
    expect(channelNameDraft('Marketing ')).toBe('marketing-');
    expect(channelNameDraft('v1.')).toBe('v1-');
    expect(channelNameDraft('marketing-')).toBe('marketing-');
    expect(channelNameDraft('marketing- ')).toBe('marketing-');
    expect(channelNameDraft('marketing-t')).toBe('marketing-t');
  });

  it('does not start with a hyphen', () => {
    expect(channelNameDraft(' ')).toBe('');
    expect(channelNameDraft('-')).toBe('');
    expect(channelNameDraft(' m')).toBe('m');
  });

  it('does not treat a combining accent as the end of a word', () => {
    expect(channelNameDraft('café')).toBe('cafe');
  });

  it('is unchanged by a second pass, so a rewritten field stays put', () => {
    for (const typed of ['Marketing Team', 'Marketing ', 'R&', 'Ålands Öl ', 'x']) {
      const once = channelNameDraft(typed, 'sv');
      expect(channelNameDraft(once, 'sv')).toBe(once);
    }
  });
});
