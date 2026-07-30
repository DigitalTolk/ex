import { useEffect, useRef } from 'react';
import { motion, useMotionValue } from 'motion/react';
import { X } from 'lucide-react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { CliffyPanel } from './CliffyPanel';
import { useCliffyStore } from './cliffy-store';
import { CliffBot } from './cliff-bot';

const LAUNCHER_SIZE = 72;
const EDGE = 8; // keep this much of the icon clear of the viewport edge
const ANCHOR_RIGHT = 20; // matches `right-5`
const ANCHOR_BOTTOM = 96; // matches `bottom-24`

/**
 * Global Cliffy entry point: the animated mascot that opens a compact chat card.
 * The mascot is DRAGGABLE (its position persists), can be DISMISSED entirely
 * (the × on hover), and is brought back with a keyboard shortcut —
 * Cmd/Ctrl+Shift+C, which also toggles the panel open/closed.
 *
 * Open/hidden/position state lives in the Cliffy store so a `/cliffy` command in
 * any composer can open it (and un-dismiss it) too.
 */
export function CliffyLauncher() {
  const open = useCliffyStore((s) => s.open);
  const hidden = useCliffyStore((s) => s.hidden);
  const openCliffy = useCliffyStore((s) => s.openCliffy);
  const close = useCliffyStore((s) => s.close);
  const hide = useCliffyStore((s) => s.hide);
  const launcherPos = useCliffyStore((s) => s.launcherPos);
  const setLauncherPos = useCliffyStore((s) => s.setLauncherPos);
  const isMobile = useIsMobile();

  // Cmd/Ctrl+Shift+C: bring Cliffy up (un-dismiss + open), or toggle it closed if
  // already open. Registered unconditionally so it works even while dismissed —
  // that's the way back. Reads live state so it never goes stale.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        const s = useCliffyStore.getState();
        if (s.open) s.close();
        else s.openCliffy();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const x = useMotionValue(launcherPos?.x ?? 0);
  const y = useMotionValue(launcherPos?.y ?? 0);
  // True once a drag actually starts, so the trailing click doesn't also open.
  const draggedRef = useRef(false);

  if (hidden) return null;

  // Constrain the drag so the icon can't be lost off-screen. Offsets are relative
  // to the default bottom-right anchor: negative x/y move it left/up.
  const bounds =
    typeof window !== 'undefined'
      ? {
          left: -(window.innerWidth - ANCHOR_RIGHT - LAUNCHER_SIZE - EDGE),
          right: ANCHOR_RIGHT - EDGE,
          top: -(window.innerHeight - ANCHOR_BOTTOM - LAUNCHER_SIZE - EDGE),
          bottom: ANCHOR_BOTTOM - EDGE,
        }
      : undefined;

  return (
    <>
      {open &&
        (isMobile ? (
          // Full-screen sheet on phones — a floating card leaves the chat
          // composer peeking underneath and is too cramped to type in.
          <motion.div
            initial={{ opacity: 0, y: '100%' }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 340, damping: 34 }}
            className="fixed inset-0 z-50 flex flex-col bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
          >
            <CliffyPanel onClose={close} />
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            style={{ transformOrigin: 'bottom right' }}
            className="fixed bottom-24 right-5 z-50 flex h-[min(620px,calc(100dvh-8rem))] w-[min(420px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl ring-1 ring-black/[0.04] dark:ring-white/[0.06]"
          >
            <CliffyPanel onClose={close} />
          </motion.div>
        ))}

      {!open && (
        <motion.div
          drag
          dragMomentum={false}
          dragElastic={0.06}
          dragConstraints={bounds}
          onDragStart={() => {
            draggedRef.current = true;
          }}
          onDragEnd={() => setLauncherPos({ x: x.get(), y: y.get() })}
          style={{ x, y }}
          className="group fixed bottom-24 right-5 z-40 cursor-grab active:cursor-grabbing"
        >
          <motion.button
            type="button"
            onPointerDown={() => {
              draggedRef.current = false;
            }}
            onClick={() => {
              if (draggedRef.current) {
                draggedRef.current = false;
                return; // that click was the end of a drag — don't open
              }
              openCliffy();
            }}
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            aria-label="Open Cliffy (Cmd/Ctrl+Shift+C)"
            style={{ width: LAUNCHER_SIZE, height: LAUNCHER_SIZE }}
            className="flex items-center justify-center [filter:drop-shadow(0_0_4px_rgba(0,0,0,0.45))_drop-shadow(0_8px_16px_rgba(0,0,0,0.30))]"
          >
            <CliffBot className="size-full" />
          </motion.button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              hide();
            }}
            aria-label="Hide Cliffy (type /cliffy or press Cmd/Ctrl+Shift+C to bring it back)"
            title="Hide Cliffy — type /cliffy or press Cmd/Ctrl+Shift+C to bring it back"
            // Hover-reveal on desktop; always tappable on touch (no hover there).
            className={`absolute -right-1 -top-1 size-5 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground shadow-md transition-colors hover:text-foreground ${
              isMobile ? 'flex' : 'hidden group-hover:flex'
            }`}
          >
            <X className="size-3" />
          </button>
        </motion.div>
      )}
    </>
  );
}
