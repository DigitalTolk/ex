import { useEffect, type RefObject } from 'react';

// useCancelOnOutsidePointer calls onCancel when a pointer goes down anywhere
// outside rootRef's element while `enabled` — on a phone, tapping away from
// an inline edit box cancels the edit.
export function useCancelOnOutsidePointer(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onCancel: (() => void) | undefined,
) {
  useEffect(() => {
    if (!enabled || !onCancel) return;
    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      /* istanbul ignore next -- the pointerdown listener is only attached while the composer is mounted, so rootRef.current is always present; defensive. */
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      onCancel();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [enabled, onCancel, rootRef]);
}
