import { describe, expect, it, vi } from 'vitest';
import { OPEN_CHANNELS_EVENT, requestOpenChannels } from './mobile-nav';

describe('requestOpenChannels', () => {
  it('fires the open-channels event on window', () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_CHANNELS_EVENT, listener);
    requestOpenChannels();
    window.removeEventListener(OPEN_CHANNELS_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
