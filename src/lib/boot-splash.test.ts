import { describe, it, expect } from 'vitest';
import { removeBootSplash } from './boot-splash';

describe('removeBootSplash', () => {
  it('removes the index.html splash node when present', () => {
    const splash = document.createElement('div');
    splash.id = 'boot-splash';
    document.body.appendChild(splash);

    removeBootSplash();

    expect(document.getElementById('boot-splash')).toBeNull();
  });

  it('is a no-op when the splash is already gone', () => {
    expect(document.getElementById('boot-splash')).toBeNull();
    expect(() => removeBootSplash()).not.toThrow();
  });
});
