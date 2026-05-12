import { describe, expect, it, vi } from 'vitest';
import { buildChannelHref, buildConversationHref } from './message-deeplink';
import { identifyMobilePushUser, clearMobilePushUser } from './mobile-push-identity';

describe('message-deeplink', () => {
  it('buildChannelHref encodes thread root and adds msg fragment', () => {
    expect(buildChannelHref('general')).toBe('/channel/general');
    expect(buildChannelHref('general', 'm-1')).toBe('/channel/general#msg-m-1');
    expect(buildChannelHref('general', 'm-1', 't-1')).toBe('/channel/general?thread=t-1#msg-m-1');
    expect(buildChannelHref('with space', 'm-1', 'thread/edge case')).toBe(
      '/channel/with space?thread=thread%2Fedge%20case#msg-m-1',
    );
  });

  it('buildConversationHref mirrors the channel shape', () => {
    expect(buildConversationHref('cv-1')).toBe('/conversation/cv-1');
    expect(buildConversationHref('cv-1', 'm-2')).toBe('/conversation/cv-1#msg-m-2');
    expect(buildConversationHref('cv-1', 'm-2', 't-1')).toBe('/conversation/cv-1?thread=t-1#msg-m-2');
  });
});

describe('mobile-push-identity', () => {
  function withOneSignal(plugin: Record<string, ReturnType<typeof vi.fn>>) {
    interface CapacitorShim { Plugins?: { OneSignalCapacitor?: typeof plugin } }
    const w = window as Window & { Capacitor?: CapacitorShim };
    w.Capacitor = { Plugins: { OneSignalCapacitor: plugin } };
    return () => { delete w.Capacitor; };
  }

  it('identifyMobilePushUser is a no-op when OneSignal is not installed', async () => {
    await identifyMobilePushUser({ id: 'u-1' });
    // No-throw — that's the entire contract on web.
    expect(true).toBe(true);
  });

  it('identifyMobilePushUser is a no-op when currentUser.id is empty', async () => {
    const login = vi.fn();
    const addTags = vi.fn();
    const cleanup = withOneSignal({ login, addTags });
    try {
      await identifyMobilePushUser({ id: '' });
      expect(login).not.toHaveBeenCalled();
      expect(addTags).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('identifyMobilePushUser calls login and addTags with the user id', async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    const addTags = vi.fn().mockResolvedValue(undefined);
    const cleanup = withOneSignal({ login, addTags });
    try {
      await identifyMobilePushUser({ id: 'u-1' });
      expect(login).toHaveBeenCalledWith({ externalId: 'u-1' });
      expect(addTags).toHaveBeenCalled();
      const tags = (addTags.mock.calls[0][0] as { tags: Record<string, string> }).tags;
      expect(tags.app).toBe('ex-mobile');
      expect(tags.user_id).toBe('u-1');
      expect(tags.server_url).toBe(window.location.origin);
    } finally {
      cleanup();
    }
  });

  it('clearMobilePushUser calls logout and removeTags when installed', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    const removeTags = vi.fn().mockResolvedValue(undefined);
    const cleanup = withOneSignal({ logout, removeTags });
    try {
      await clearMobilePushUser();
      expect(logout).toHaveBeenCalled();
      expect(removeTags).toHaveBeenCalledWith({ keys: ['user_id'] });
    } finally {
      cleanup();
    }
  });

  it('clearMobilePushUser is a no-op without OneSignal', async () => {
    await clearMobilePushUser();
    expect(true).toBe(true);
  });
});
