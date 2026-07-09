import { describe, it, expect, afterEach } from 'vitest';
import { hasDndBridge, isDndActive } from '@/lib/dnd';

// The shell DnD bridge wrapper must fail toward the AUDIBLE alert: any
// missing/broken bridge reads as "not DnD" so a ping is never silently
// swallowed by a faulty shell integration.

afterEach(() => {
  delete window.__EX_DND__;
});

describe('hasDndBridge', () => {
  it('is false without the shell bridge', () => {
    expect(hasDndBridge()).toBe(false);
  });

  it('is false when the global is present but not a function', () => {
    (window as { __EX_DND__?: unknown }).__EX_DND__ = true;
    expect(hasDndBridge()).toBe(false);
  });

  it('is true when the shell exposes the query function', () => {
    window.__EX_DND__ = () => false;
    expect(hasDndBridge()).toBe(true);
  });
});

describe('isDndActive', () => {
  it('resolves false without a bridge', async () => {
    await expect(isDndActive()).resolves.toBe(false);
  });

  it('resolves a synchronous boolean bridge answer', async () => {
    window.__EX_DND__ = () => true;
    await expect(isDndActive()).resolves.toBe(true);
    window.__EX_DND__ = () => false;
    await expect(isDndActive()).resolves.toBe(false);
  });

  it('resolves an async (IPC-style) bridge answer', async () => {
    window.__EX_DND__ = () => Promise.resolve(true);
    await expect(isDndActive()).resolves.toBe(true);
  });

  it('coerces truthy non-boolean bridge answers', async () => {
    (window as { __EX_DND__?: unknown }).__EX_DND__ = () => 1;
    await expect(isDndActive()).resolves.toBe(true);
  });

  it('resolves false when the bridge throws (fail toward audible)', async () => {
    window.__EX_DND__ = () => {
      throw new Error('ipc dead');
    };
    await expect(isDndActive()).resolves.toBe(false);
  });

  it('resolves false when the bridge rejects (fail toward audible)', async () => {
    window.__EX_DND__ = () => Promise.reject(new Error('ipc dead'));
    await expect(isDndActive()).resolves.toBe(false);
  });
});
