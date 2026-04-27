import { useSyncExternalStore } from 'react';

// BUILD_VERSION is the version this bundle shipped with — frozen at
// `npm run build` time via the Vite `define` config.
export const BUILD_VERSION: string =
  typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev';

// The server emits its build version once per WebSocket handshake;
// stashed in a module-level store so consumers subscribe via
// useSyncExternalStore without prop-drilling or a Context layer. The
// WS reconnects on deploy, so the client always sees the freshest
// build without HTTP polling.

let serverVersion: string | null = null;
const subscribers = new Set<() => void>();

export function setServerVersion(v: string): void {
  if (!v || v === serverVersion) return;
  serverVersion = v;
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): string | null {
  return serverVersion;
}

export function useServerVersion(): {
  serverVersion: string | null;
  outdated: boolean;
} {
  const v = useSyncExternalStore(subscribe, getSnapshot, () => null);
  // We only treat `outdated=true` after we've heard the version frame
  // AND the value differs. Silence the banner during the connect window
  // (and entirely in dev where every reload is a "different" build).
  const outdated = v !== null && v !== BUILD_VERSION && BUILD_VERSION !== 'dev';
  return { serverVersion: v, outdated };
}
