import { describe, expect, it, beforeEach } from 'vitest';
import { useCliffyStore, isCliffyCommand, cliffyPrompt } from './cliffy-store';

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

  it('close resets open + seed', () => {
    useCliffyStore.getState().openCliffy({ prompt: 'x' });
    useCliffyStore.getState().close();
    expect(useCliffyStore.getState().open).toBe(false);
    expect(useCliffyStore.getState().seedPrompt).toBeNull();
  });
});
