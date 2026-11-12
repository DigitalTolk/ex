import type { ReactNode } from 'react';

// ShortcutHint is the muted key label at the right edge of a dropdown row
// (⌘1, Enter). Phones have no keyboard to press it with, so it hides there.
export function ShortcutHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground mobile:hidden">
      {children}
    </kbd>
  );
}
