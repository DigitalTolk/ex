import { useSyncExternalStore } from 'react';
import { deviceKind, type DeviceKind } from '@/lib/device';

const MOBILE_QUERY = '(max-width: 767px)';

// "Mobile" is the mobile-NATIVE tier: a narrow viewport on a TOUCH device.
// A desktop window squeezed below 768px (Slack-next-to-ex half screen) is the
// compact tier instead — desktop chrome, no drawer gestures, no sheets. Test
// setups pin the device kind to 'touch' so historical width-driven tests keep
// their meaning; see lib/device.ts.
//
// Every message row asks, so the whole app shares ONE MediaQueryList and ONE
// change listener that fans out to the mounted hooks (as usePointerDevice
// does). It used to be a matchMedia query plus a listener per mount.

let shared: { matchMedia: typeof window.matchMedia; query: MediaQueryList } | null = null;
const listeners = new Set<() => void>();

// The shared list is rebuilt when window.matchMedia itself is replaced — a
// viewport emulation (and every test that installs its own) swaps it.
function mobileQuery(): MediaQueryList | null {
  if (typeof window.matchMedia !== 'function') return null;
  if (shared?.matchMedia !== window.matchMedia) {
    shared = { matchMedia: window.matchMedia, query: window.matchMedia(MOBILE_QUERY) };
  }
  return shared.query;
}

// The device kind only changes when its inputs do (a forced kind in tests;
// the native shell flags are fixed for the page's life), so it is resolved
// once per input instead of on every row render — deviceKind() runs a
// matchMedia query of its own in a plain browser.
let device: { force: DeviceKind | undefined; kind: DeviceKind } | null = null;

function currentDeviceKind(): DeviceKind {
  const force = window.__EX_FORCE_DEVICE__;
  if (!device || device.force !== force) device = { force, kind: deviceKind() };
  return device.kind;
}

function getSnapshot(): boolean {
  const query = mobileQuery();
  return !!query?.matches && currentDeviceKind() === 'touch';
}

function notify() {
  for (const listener of listeners) listener();
}

// The one change listener, on whichever list is current: a replaced
// matchMedia moves it to the new list.
let attached: MediaQueryList | null = null;

function detach() {
  if (!attached) return;
  if (typeof attached.removeEventListener === 'function') attached.removeEventListener('change', notify);
  else attached.removeListener?.(notify);
  attached = null;
}

function attach(query: MediaQueryList) {
  if (attached === query) return;
  detach();
  if (typeof query.addEventListener === 'function') query.addEventListener('change', notify);
  else query.addListener?.(notify);
  attached = query;
}

function subscribe(onChange: () => void): () => void {
  const query = mobileQuery();
  if (!query) return () => undefined;
  listeners.add(onChange);
  attach(query);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) detach();
  };
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
