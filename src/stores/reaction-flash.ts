import { useSyncExternalStore } from 'react';

// A reaction to one of your messages does not count or dot the Activity
// bell. It flashes instead: the bell becomes that emoji for a moment, then
// returns, so you notice it without a number sitting there afterwards.
// Module state, read by the sidebar switch and the phone tab bar.
export const REACTION_FLASH_MS = 1600;

export interface ReactionFlash {
  emoji: string;
  // Increments per flash so a repeat of the same emoji still re-renders.
  seq: number;
}

let current: ReactionFlash | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function notify() {
  for (const cb of listeners) cb();
}

export function flashReaction(emoji: string): void {
  if (!emoji) return;
  current = { emoji, seq: ++seq };
  clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    timer = undefined;
    notify();
  }, REACTION_FLASH_MS);
  notify();
}

export function subscribeReactionFlash(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getReactionFlash(): ReactionFlash | null {
  return current;
}

export function useReactionFlash(): ReactionFlash | null {
  return useSyncExternalStore(subscribeReactionFlash, getReactionFlash);
}

export function resetReactionFlashForTests(): void {
  clearTimeout(timer);
  timer = undefined;
  current = null;
}
