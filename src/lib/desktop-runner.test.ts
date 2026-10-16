import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canControl,
  compareVersions,
  desktopRunner,
  hasDesktopRunner,
  nextStep,
  readState,
  updateAvailable,
  type DesktopRunnerState,
} from '@/lib/desktop-runner';
import { harnessLabel, harnessVersion, osLabel } from '@/lib/runner-labels';

const ORIGIN = 'https://ex.example.com';

function state(over: Partial<DesktopRunnerState> = {}): DesktopRunnerState {
  return { ...readState({ supported: true }), ...over };
}

const conn = {
  server: ORIGIN,
  user: 'Alice',
  label: 'mac',
  tokenId: 'rt1',
  expiresAt: '2026-11-01T00:00:00Z',
  expired: false,
};

afterEach(() => {
  delete window.__EX_RUNNER__;
});

describe('readState', () => {
  it('reads anything malformed as safe defaults', () => {
    for (const raw of [null, undefined, 'x', 42, {}]) {
      expect(readState(raw)).toEqual({
        supported: false,
        binary: null,
        latestVersion: null,
        connection: null,
        process: 'stopped',
        external: false,
        autoStart: false,
        busy: null,
        progress: null,
        error: null,
      });
    }
    const odd = readState({
      binary: { version: '' },
      connection: { server: ORIGIN },
      process: 'exploding',
      busy: 'dancing',
      progress: 7,
      error: 3,
    });
    expect(odd.binary).toBeNull();
    expect(odd.connection).toBeNull();
    expect(odd.process).toBe('stopped');
    expect(odd.busy).toBeNull();
    expect(odd.progress).toBeNull();
    expect(odd.error).toBeNull();
  });

  it('keeps every well-formed field', () => {
    const s = readState({
      supported: true,
      binary: { version: '0.0.3', source: 'app' },
      latestVersion: '0.0.4',
      connection: { ...conn, expired: true, user: 5 },
      process: 'running',
      external: true,
      autoStart: true,
      busy: 'installing',
      progress: 0.5,
      error: 'boom',
    });
    expect(s).toEqual({
      supported: true,
      binary: { version: '0.0.3', source: 'app' },
      latestVersion: '0.0.4',
      connection: { ...conn, expired: true, user: '' },
      process: 'running',
      external: true,
      autoStart: true,
      busy: 'installing',
      progress: 0.5,
      error: 'boom',
    });
    expect(readState({ binary: { version: '1.0.0', source: 'brew' } }).binary?.source).toBe('system');
  });
});

describe('versions', () => {
  it('orders releases numerically and local builds last', () => {
    expect(compareVersions('0.0.10', '0.0.9')).toBe(1);
    expect(compareVersions('0.0.3', '0.0.3')).toBe(0);
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1')).toBe(0);
    expect(compareVersions('0.1.1', '0.1')).toBe(1);
    expect(compareVersions('0.0.2', '0.0.3')).toBe(-1);
    expect(compareVersions('dev', '9.9.9')).toBe(1);
    expect(compareVersions('9.9.9', 'dev')).toBe(-1);
    expect(compareVersions('dev', 'local')).toBe(0);
  });

  it('can control 0.0.3 and newer, and offers newer releases', () => {
    expect(canControl({ version: '0.0.2', source: 'system' })).toBe(false);
    expect(canControl({ version: '0.0.3', source: 'app' })).toBe(true);
    expect(canControl({ version: 'dev', source: 'app' })).toBe(true);
    const bin = { version: '0.0.3', source: 'app' as const };
    expect(updateAvailable(state({ binary: bin, latestVersion: '0.0.4' }))).toBe(true);
    expect(updateAvailable(state({ binary: bin, latestVersion: '0.0.3' }))).toBe(false);
    expect(updateAvailable(state({ binary: bin, latestVersion: null }))).toBe(false);
    expect(updateAvailable(state({ binary: null, latestVersion: '0.0.4' }))).toBe(false);
  });
});

describe('nextStep', () => {
  const bin = { version: '0.0.3', source: 'app' as const };
  it('walks install → connect → start, and running wins', () => {
    expect(nextStep(state(), ORIGIN, null)).toEqual({ step: 'install' });
    expect(nextStep(state({ binary: { version: '0.0.2', source: 'system' } }), ORIGIN, null)).toEqual({
      step: 'update',
      reason: 'too-old',
    });
    expect(nextStep(state({ binary: bin }), ORIGIN, null)).toEqual({ step: 'connect', reason: 'new' });
    expect(nextStep(state({ binary: bin, connection: { ...conn, server: 'https://other' } }), ORIGIN, null)).toEqual({
      step: 'connect',
      reason: 'other-server',
    });
    expect(nextStep(state({ binary: bin, connection: { ...conn, expired: true } }), ORIGIN, null)).toEqual({
      step: 'connect',
      reason: 'expired',
    });
    expect(nextStep(state({ binary: bin, connection: conn }), ORIGIN, new Set(['rt9']))).toEqual({
      step: 'connect',
      reason: 'not-yours',
    });
    expect(nextStep(state({ binary: bin, connection: conn }), ORIGIN, new Set(['rt1']))).toEqual({ step: 'start' });
    expect(nextStep(state({ binary: bin, connection: conn }), ORIGIN, null)).toEqual({ step: 'start' });
    expect(nextStep(state({ process: 'running' }), ORIGIN, null)).toEqual({ step: 'running' });
  });
});

describe('desktopRunner', () => {
  it('is absent in a browser', async () => {
    expect(hasDesktopRunner()).toBe(false);
    await expect(desktopRunner.start()).rejects.toThrow('The ex desktop app is needed for this.');
    const off = desktopRunner.subscribe(() => {});
    expect(off).toBeTypeOf('function');
    expect(off()).toBeUndefined();
    window.__EX_RUNNER__ = { call: 'nope', subscribe: () => () => {} } as unknown as typeof window.__EX_RUNNER__;
    expect(hasDesktopRunner()).toBe(false);
  });

  it('maps every action to one bridge call', async () => {
    const call = vi.fn(async (op: string) => {
      if (op === 'getState') return { supported: true };
      if (op === 'readLog') return ['a', 2, 'b'];
      if (op === 'beginConnect') return { port: 5000, state: 's', challenge: 'c' };
      return 'ignored';
    });
    let pushed: ((s: unknown) => void) | null = null;
    const unsubscribe = vi.fn();
    window.__EX_RUNNER__ = {
      call,
      subscribe: (l) => {
        pushed = l;
        return unsubscribe;
      },
    };
    expect(hasDesktopRunner()).toBe(true);
    expect((await desktopRunner.getState()).supported).toBe(true);
    expect(await desktopRunner.readLog()).toEqual(['a', 'b']);
    expect(await desktopRunner.beginConnect()).toEqual({ port: 5000, state: 's', challenge: 'c', name: 'this computer' });
    for (const fn of [
      desktopRunner.install,
      desktopRunner.cancelConnect,
      desktopRunner.start,
      desktopRunner.stop,
      desktopRunner.disconnect,
      desktopRunner.uninstall,
    ]) {
      expect(await fn()).toBeUndefined();
    }
    await desktopRunner.finishConnect('code-1');
    await desktopRunner.setAutoStart(true);
    expect(call).toHaveBeenCalledWith('finishConnect', { code: 'code-1' });
    expect(call).toHaveBeenCalledWith('setAutoStart', { on: true });
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      'getState',
      'readLog',
      'beginConnect',
      'install',
      'cancelConnect',
      'start',
      'stop',
      'disconnect',
      'uninstall',
      'finishConnect',
      'setAutoStart',
    ]);

    const seen: DesktopRunnerState[] = [];
    const off = desktopRunner.subscribe((s) => seen.push(s));
    pushed!({ process: 'running' });
    expect(seen[0].process).toBe('running');
    off();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('refuses a malformed connect request and a non-list log', async () => {
    const answers: Record<string, unknown> = { beginConnect: { port: 80, state: 's', challenge: 'c' }, readLog: 'x' };
    window.__EX_RUNNER__ = { call: async (op) => answers[op], subscribe: () => () => {} };
    await expect(desktopRunner.beginConnect()).rejects.toThrow('invalid connect request');
    answers.beginConnect = null;
    await expect(desktopRunner.beginConnect()).rejects.toThrow('invalid connect request');
    answers.beginConnect = { port: 5000, state: '', challenge: 'c' };
    await expect(desktopRunner.beginConnect()).rejects.toThrow('invalid connect request');
    expect(await desktopRunner.readLog()).toEqual([]);
  });
});

describe('runner labels', () => {
  it('names known systems and CLIs, and passes others through', () => {
    expect(osLabel('darwin')).toBe('macOS');
    expect(osLabel('plan9')).toBe('plan9');
    expect(harnessLabel('codex')).toBe('Codex');
    expect(harnessLabel('gemini')).toBe('gemini');
    expect(harnessVersion('2.1.223 (Claude Code)')).toBe('2.1.223');
    expect(harnessVersion('codex-cli 0.147.0')).toBe('0.147.0');
    expect(harnessVersion('nightly')).toBe('nightly');
  });
});
