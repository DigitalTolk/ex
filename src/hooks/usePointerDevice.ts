import { useSyncExternalStore } from 'react';
import { hasPointerDevice, subscribePointerDevice } from '@/lib/device';

// usePointerDevice reports whether a mouse or trackpad is available, so a
// component can offer the hover affordance (message toolbar, row actions)
// instead of its touch stand-in. On a desktop it is trivially true; on an
// iPad it follows the Magic Keyboard / mouse being attached. The sources are
// wired by startLayoutTierTracking() at app boot (see lib/device.ts), which
// also mirrors the state onto the root `device-touch` class for the `touch:`
// CSS variant.
export function usePointerDevice(): boolean {
  return useSyncExternalStore(subscribePointerDevice, hasPointerDevice);
}
