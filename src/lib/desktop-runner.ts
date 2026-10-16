// The ex desktop app's control over ex-runner on this computer, used by the
// Runners tab. The app's preload injects window.__EX_RUNNER__ (ex-electron
// src/lib/runner-control.ts); a browser has none, and the Mac App Store build
// answers `supported: false` (its sandbox can't run the harness CLIs). So
// everything here is optional — the tab falls back to the command-line steps.
//
// The bridge is a generic call(op, arg) plus a state subscription. The state
// arrives from another program, possibly an older or newer one, so it is
// read defensively (readState) rather than trusted.

export type RunnerProcess = 'stopped' | 'starting' | 'running' | 'stopping';
export type RunnerBusy = 'installing' | 'connecting' | 'disconnecting' | 'removing';

export interface DesktopRunnerBinary {
  version: string;
  // 'app': the copy the desktop app installed (it can update or remove it).
  // 'system': one found on PATH, e.g. from Homebrew (updated there).
  source: 'app' | 'system';
}

export interface DesktopRunnerConnection {
  server: string;
  user: string;
  label: string;
  tokenId: string;
  expiresAt: string;
  expired: boolean;
}

export interface DesktopRunnerState {
  supported: boolean;
  binary: DesktopRunnerBinary | null;
  latestVersion: string | null;
  connection: DesktopRunnerConnection | null;
  process: RunnerProcess;
  // Running, but not started by this app (a Homebrew service or a terminal).
  external: boolean;
  autoStart: boolean;
  busy: RunnerBusy | null;
  // Download progress 0..1 while installing, when known.
  progress: number | null;
  // The last thing that went wrong, already worded for people.
  error: string | null;
}

// What `ex-runner login --no-browser` is waiting for: the SPA approves the
// pairing with its own session and hands the one-time code back.
export interface DesktopConnectRequest {
  port: number;
  state: string;
  challenge: string;
  name: string;
}

interface RunnerBridge {
  call: (op: string, arg?: unknown) => Promise<unknown>;
  subscribe: (listener: (state: unknown) => void) => () => void;
}

function bridge(): RunnerBridge | null {
  const b = window.__EX_RUNNER__;
  return b && typeof b.call === 'function' && typeof b.subscribe === 'function' ? b : null;
}

// hasDesktopRunner reports whether this page runs inside a desktop app that
// can control ex-runner at all (it may still answer `supported: false`).
export function hasDesktopRunner(): boolean {
  return bridge() !== null;
}

const PROCESSES: readonly RunnerProcess[] = ['stopped', 'starting', 'running', 'stopping'];
const BUSY: readonly RunnerBusy[] = ['installing', 'connecting', 'disconnecting', 'removing'];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// readState turns whatever the desktop app sent into a well-formed state.
// Anything missing or malformed reads as its safe default — never a crash.
export function readState(raw: unknown): DesktopRunnerState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bin = r.binary && typeof r.binary === 'object' ? (r.binary as Record<string, unknown>) : null;
  const conn = r.connection && typeof r.connection === 'object' ? (r.connection as Record<string, unknown>) : null;
  const progress = typeof r.progress === 'number' && r.progress >= 0 && r.progress <= 1 ? r.progress : null;
  return {
    supported: r.supported === true,
    binary: bin && str(bin.version) ? { version: str(bin.version), source: bin.source === 'app' ? 'app' : 'system' } : null,
    latestVersion: str(r.latestVersion) || null,
    connection:
      conn && str(conn.server) && str(conn.tokenId)
        ? {
            server: str(conn.server),
            user: str(conn.user),
            label: str(conn.label),
            tokenId: str(conn.tokenId),
            expiresAt: str(conn.expiresAt),
            expired: conn.expired === true,
          }
        : null,
    process: PROCESSES.includes(r.process as RunnerProcess) ? (r.process as RunnerProcess) : 'stopped',
    external: r.external === true,
    autoStart: r.autoStart === true,
    busy: BUSY.includes(r.busy as RunnerBusy) ? (r.busy as RunnerBusy) : null,
    progress,
    error: str(r.error) || null,
  };
}

function readConnectRequest(raw: unknown): DesktopConnectRequest {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const port = typeof r.port === 'number' ? r.port : NaN;
  if (!(port >= 1024 && port <= 65535) || !str(r.state) || !str(r.challenge)) {
    throw new Error('The desktop app sent an invalid connect request.');
  }
  return { port, state: str(r.state), challenge: str(r.challenge), name: str(r.name) || 'this computer' };
}

async function call(op: string, arg?: unknown): Promise<unknown> {
  const b = bridge();
  if (!b) throw new Error('The ex desktop app is needed for this.');
  return b.call(op, arg);
}

// desktopRunner is the typed surface over the bridge. Every action resolves
// once the desktop app has done it (or rejects with a message for people).
export const desktopRunner = {
  getState: async () => readState(await call('getState')),
  subscribe(listener: (state: DesktopRunnerState) => void): () => void {
    const b = bridge();
    if (!b) return () => {};
    return b.subscribe((raw) => listener(readState(raw)));
  },
  install: () => call('install').then(() => undefined),
  beginConnect: async () => readConnectRequest(await call('beginConnect')),
  finishConnect: (code: string) => call('finishConnect', { code }).then(() => undefined),
  cancelConnect: () => call('cancelConnect').then(() => undefined),
  start: () => call('start').then(() => undefined),
  stop: () => call('stop').then(() => undefined),
  setAutoStart: (on: boolean) => call('setAutoStart', { on }).then(() => undefined),
  disconnect: () => call('disconnect').then(() => undefined),
  uninstall: () => call('uninstall').then(() => undefined),
  readLog: async (): Promise<string[]> => {
    const lines = await call('readLog');
    return Array.isArray(lines) ? lines.filter((l): l is string => typeof l === 'string') : [];
  },
};

// The oldest ex-runner the app can drive: `login --no-browser` and
// `status --json` arrived in 0.0.3.
export const MIN_CONTROLLABLE_VERSION = '0.0.3';

// compareVersions orders dotted release versions numerically. A local build
// ("dev", or anything non-numeric) sorts above every release.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa === pb ? 0 : pa ? -1 : 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function canControl(binary: DesktopRunnerBinary): boolean {
  return compareVersions(binary.version, MIN_CONTROLLABLE_VERSION) >= 0;
}

export function updateAvailable(state: DesktopRunnerState): boolean {
  return !!state.binary && !!state.latestVersion && compareVersions(state.latestVersion, state.binary.version) > 0;
}

// The one thing the "This computer" card asks for next.
export type RunnerStep =
  | { step: 'install' }
  | { step: 'update'; reason: 'too-old' }
  | { step: 'connect'; reason: 'new' | 'expired' | 'other-server' | 'not-yours' }
  | { step: 'start' }
  | { step: 'running' };

// nextStep reads the card's state machine: install → connect → start. A
// running runner is "running" even when something else still needs doing —
// stopping agents to fix it is the person's call, not the card's.
// ownInstalls are the caller's paired install ids (from the Runners list),
// so a computer whose install was disconnected, or belongs to someone
// else, asks to connect again.
export function nextStep(state: DesktopRunnerState, origin: string, ownInstalls: ReadonlySet<string> | null): RunnerStep {
  if (state.process === 'running') return { step: 'running' };
  if (!state.binary) return { step: 'install' };
  if (!canControl(state.binary)) return { step: 'update', reason: 'too-old' };
  const c = state.connection;
  if (!c) return { step: 'connect', reason: 'new' };
  if (c.server !== origin) return { step: 'connect', reason: 'other-server' };
  if (c.expired) return { step: 'connect', reason: 'expired' };
  if (ownInstalls && !ownInstalls.has(c.tokenId)) return { step: 'connect', reason: 'not-yours' };
  return { step: 'start' };
}
