import { describe, expect, it } from 'vitest';
import { DEFAULT_QUICK_REACTIONS, padQuickReactions } from './quick-reactions';

describe('padQuickReactions', () => {
  it('fills a new account with the stock set', () => {
    expect(padQuickReactions(undefined)).toEqual(DEFAULT_QUICK_REACTIONS);
    expect(padQuickReactions([])).toEqual(DEFAULT_QUICK_REACTIONS);
  });

  it('puts the most-used emojis first and tops up without repeating them', () => {
    expect(padQuickReactions([':tada:', ':shipit:'])).toEqual([
      ':tada:',
      ':shipit:',
      ':thumbsup:',
      ':white_check_mark:',
      ':eyes:',
      ':heart:',
    ]);
  });

  it('caps a long history at the row length', () => {
    const many = [':a:', ':b:', ':c:', ':d:', ':e:', ':f:', ':g:'];
    expect(padQuickReactions(many)).toEqual(many.slice(0, 6));
    expect(padQuickReactions(many, 2)).toEqual([':a:', ':b:']);
  });
});
