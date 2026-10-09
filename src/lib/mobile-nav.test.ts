import { beforeEach, describe, expect, it } from 'vitest';
import { requestOpenChannels, takeOpenChannelsRequest, useOpenChannelsRequest } from './mobile-nav';

describe('requestOpenChannels', () => {
  beforeEach(() => useOpenChannelsRequest.setState({ pending: false }));

  // A request waits until it is taken, so one made before AppLayout listens
  // is not lost — and it is served once.
  it('leaves a request that is taken exactly once', () => {
    expect(takeOpenChannelsRequest()).toBe(false);
    requestOpenChannels();
    expect(useOpenChannelsRequest.getState().pending).toBe(true);
    expect(takeOpenChannelsRequest()).toBe(true);
    expect(takeOpenChannelsRequest()).toBe(false);
  });
});
