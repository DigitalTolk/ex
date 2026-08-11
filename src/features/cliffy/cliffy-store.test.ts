import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  useCliffyStore,
  isCliffyCommand,
  cliffyPrompt,
  resetCliffyWidgetForTests,
} from './cliffy-store';

describe('cliffy command parser', () => {
  it('detects /cliffy invocations (bare, with text, padded, any case)', () => {
    expect(isCliffyCommand('/cliffy')).toBe(true);
    expect(isCliffyCommand('/cliffy create a task')).toBe(true);
    expect(isCliffyCommand('  /cliffy hi  ')).toBe(true);
    expect(isCliffyCommand('/CliffY yo')).toBe(true);
  });

  it('ignores non-invocations', () => {
    expect(isCliffyCommand('hello /cliffy')).toBe(false); // not at the start
    expect(isCliffyCommand('/cliffytask')).toBe(false); // no separating space
    expect(isCliffyCommand('/schedule x')).toBe(false);
    expect(isCliffyCommand('')).toBe(false);
  });

  it('extracts the prompt after the command', () => {
    expect(cliffyPrompt('/cliffy create a task for Habib')).toBe('create a task for Habib');
    expect(cliffyPrompt('/cliffy')).toBe('');
    expect(cliffyPrompt('  /cliffy   hi ')).toBe('hi');
  });
});

describe('cliffy store', () => {
  beforeEach(() => useCliffyStore.setState({ open: false, seedPrompt: null, scope: null }));

  it('openCliffy sets open + seed + scope', () => {
    useCliffyStore.getState().openCliffy({ prompt: 'do it', scope: { type: 'channel', id: 'c1', name: 'general' } });
    const s = useCliffyStore.getState();
    expect(s.open).toBe(true);
    expect(s.seedPrompt).toBe('do it');
    expect(s.scope).toEqual({ type: 'channel', id: 'c1', name: 'general' });
  });

  it('a blank prompt yields a null seed (opens ready for input)', () => {
    useCliffyStore.getState().openCliffy({ prompt: '   ' });
    expect(useCliffyStore.getState().seedPrompt).toBeNull();
  });

  it('consumeSeed returns the prompt once then clears it', () => {
    useCliffyStore.getState().openCliffy({ prompt: 'x' });
    expect(useCliffyStore.getState().consumeSeed()).toBe('x');
    expect(useCliffyStore.getState().seedPrompt).toBeNull();
    expect(useCliffyStore.getState().consumeSeed()).toBeNull();
  });

  it('openCliffy without a scope keeps the previous scope', () => {
    useCliffyStore.setState({ scope: { type: 'channel', id: 'c1' } });
    useCliffyStore.getState().openCliffy({ prompt: 'x' });
    expect(useCliffyStore.getState().scope).toEqual({ type: 'channel', id: 'c1' });
  });

  it('setScope tracks the chat the user is looking at', () => {
    // The panel is shared, so the scope must follow navigation — otherwise
    // Cliffy would answer about whichever chat it was first opened from.
    useCliffyStore.getState().setScope({ type: 'conversation', id: 'd-9', name: 'Alice' });
    expect(useCliffyStore.getState().scope).toEqual({ type: 'conversation', id: 'd-9', name: 'Alice' });
    useCliffyStore.getState().setScope(null);
    expect(useCliffyStore.getState().scope).toBeNull();
  });

  it('close resets open + seed', () => {
    useCliffyStore.getState().openCliffy({ prompt: 'x' });
    useCliffyStore.getState().close();
    expect(useCliffyStore.getState().open).toBe(false);
    expect(useCliffyStore.getState().seedPrompt).toBeNull();
  });
});

describe('cliffy store persistence', () => {
  const KEY = 'cliffy.widget.v1';

  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it('hide/showWidget/setLauncherPos round-trip through localStorage', () => {
    const s = () => useCliffyStore.getState();
    s().hide();
    expect(s().hidden).toBe(true);
    expect(s().open).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ hidden: true, pos: null });

    s().showWidget();
    expect(s().hidden).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(KEY)!).hidden).toBe(false);

    s().setLauncherPos({ x: -40, y: -12 });
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({
      hidden: false,
      pos: { x: -40, y: -12 },
    });
  });

  it('setCliffhubBase stores the origin the session probe reported', () => {
    useCliffyStore.getState().setCliffhubBase('https://hub.example.test');
    expect(useCliffyStore.getState().cliffhubBase).toBe('https://hub.example.test');
    useCliffyStore.getState().setCliffhubBase(null);
    expect(useCliffyStore.getState().cliffhubBase).toBeNull();
  });

  it('a fresh module load restores a persisted widget', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ hidden: true, pos: { x: -7, y: -9 } }));
    const mod = await import('./cliffy-store');
    expect(mod.useCliffyStore.getState().hidden).toBe(true);
    expect(mod.useCliffyStore.getState().launcherPos).toEqual({ x: -7, y: -9 });
  });

  it('a persisted entry with no pos loads as the default anchor', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ hidden: false }));
    const mod = await import('./cliffy-store');
    expect(mod.useCliffyStore.getState().launcherPos).toBeNull();
  });

  it('corrupt persisted JSON falls back to first-visit defaults', async () => {
    window.localStorage.setItem(KEY, '{not json');
    const mod = await import('./cliffy-store');
    expect(mod.useCliffyStore.getState().hidden).toBe(false);
    expect(mod.useCliffyStore.getState().launcherPos).toBeNull();
  });

  it('a write that throws is swallowed — a full or blocked store must not break dismissing', () => {
    const setItem = vi
      .spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    expect(() => useCliffyStore.getState().hide()).not.toThrow();
    // The in-memory state still moved; only the persisted copy was lost.
    expect(useCliffyStore.getState().hidden).toBe(true);
    setItem.mockRestore();
  });

  it('resetCliffyWidgetForTests survives a storage that refuses removeItem', () => {
    const removeItem = vi
      .spyOn(window.localStorage, 'removeItem')
      .mockImplementation(() => {
        throw new Error('denied');
      });
    useCliffyStore.getState().hide();
    expect(() => resetCliffyWidgetForTests()).not.toThrow();
    expect(useCliffyStore.getState().hidden).toBe(false);
    removeItem.mockRestore();
  });
});
