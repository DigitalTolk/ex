import { create } from 'zustand';

// A reaction to one of your messages does not count or dot the Activity
// bell. It flashes instead: the bell becomes that emoji for a moment, then
// returns, so you notice it without a number sitting there afterwards.
// Read by the sidebar switch and the phone tab bar.
export const REACTION_FLASH_MS = 1600;

export interface ReactionFlash {
  emoji: string;
  // Increments per flash so a repeat of the same emoji still re-renders.
  seq: number;
}

interface ReactionFlashState {
  flash: ReactionFlash | null;
  seq: number;
}

const useReactionFlashStore = create<ReactionFlashState>(() => ({ flash: null, seq: 0 }));

export function flashReaction(emoji: string): void {
  if (!emoji) return;
  const flash = { emoji, seq: useReactionFlashStore.getState().seq + 1 };
  useReactionFlashStore.setState({ flash, seq: flash.seq });
  // Each flash clears only itself: a later one restarts the clock.
  setTimeout(() => {
    if (useReactionFlashStore.getState().flash === flash) useReactionFlashStore.setState({ flash: null });
  }, REACTION_FLASH_MS);
}

export function getReactionFlash(): ReactionFlash | null {
  return useReactionFlashStore.getState().flash;
}

export function useReactionFlash(): ReactionFlash | null {
  return useReactionFlashStore((s) => s.flash);
}
