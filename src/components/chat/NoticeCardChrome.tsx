import type { ReactNode } from 'react';

// The shared chrome for the cards that float above the composer — the approval
// gate and the watcher catch-up ask. Both hand-wrote the same stack and card
// classes, so a tweak to one silently drifted from the other.
//
// The accent classes are LITERAL strings in a lookup, not interpolated: a
// Tailwind class assembled at runtime is never emitted by the compiler, so
// `border-${accent}/30` would render an unstyled card.

export type NoticeAccent = 'approval' | 'catchup';

const ACCENTS: Record<NoticeAccent, { card: string; header: string }> = {
  approval: { card: 'border-amber-500/30', header: 'border-amber-500/20 bg-amber-500/10' },
  catchup: { card: 'border-primary/30', header: 'border-primary/20 bg-primary/10' },
};

// noticeStackClass lays out a column of notice cards above the composer.
export const noticeStackClass = 'pointer-events-auto mb-1 ml-1 flex w-fit max-w-xl flex-col gap-2';

// NoticeCard is one card: an accent-tinted border over a blurred background,
// with a header strip in the same accent.
export function NoticeCard({
  accent,
  testID,
  header,
  children,
}: {
  accent: NoticeAccent;
  testID: string;
  header: ReactNode;
  children: ReactNode;
}) {
  const a = ACCENTS[accent];
  return (
    <div
      data-testid={testID}
      className={`w-full overflow-hidden rounded-xl border ${a.card} bg-background/95 shadow-lg backdrop-blur`}
    >
      <div className={`flex items-center gap-2 border-b ${a.header} px-3 py-2`}>{header}</div>
      <div className="px-3 py-2.5">{children}</div>
    </div>
  );
}
