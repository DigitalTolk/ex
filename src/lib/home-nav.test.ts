import { describe, expect, it } from 'vitest';
import { HOME_NAV_STATE, isHomeNav } from './home-nav';

describe('isHomeNav', () => {
  it('recognises the state the workspace mark navigates with', () => {
    expect(isHomeNav(HOME_NAV_STATE)).toBe(true);
  });

  it('ignores any other navigation state', () => {
    for (const state of [undefined, null, 'home', {}, { homeView: 'yes' }, { from: '/threads' }]) {
      expect(isHomeNav(state)).toBe(false);
    }
  });
});
