type CapacitorPlugins = NonNullable<NonNullable<Window['Capacitor']>['Plugins']>;

// Identity-based cache: invalidates automatically when window.Capacitor is
// reassigned or deleted (e.g. between tests that toggle the global). In
// production the native bridge sets window.Capacitor once at startup, so
// after the first call this stays a cheap pointer compare.
const UNSET: unique symbol = Symbol('capacitor-unset');
let cachedRef: typeof window.Capacitor | typeof UNSET = UNSET;
let cachedIsNative = false;

export function isNativePlatform(): boolean {
  if (window.Capacitor !== cachedRef) {
    cachedRef = window.Capacitor;
    cachedIsNative = window.Capacitor?.isNativePlatform?.() === true;
  }
  return cachedIsNative;
}

export function getCapacitorPlugin<K extends keyof CapacitorPlugins>(
  name: K,
): CapacitorPlugins[K] | undefined {
  return window.Capacitor?.Plugins?.[name];
}
