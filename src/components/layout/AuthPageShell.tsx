import type { ReactNode } from 'react';
import { UpdateBanner } from '@/components/UpdateBanner';

// AuthPageShell is the frame of the signed-out screens (sign in, invite,
// password reset). It fills the app root — which already clears the status bar
// and ends at the keyboard — and scrolls inside it, so the form is centred and
// a focused field can scroll above the keyboard.
export function AuthPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-muted/40">
      <UpdateBanner />
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {/* Centred against the full screen, so the keyboard opening doesn't
            re-centre (and jump) the form — the area above it just scrolls. */}
        <div className="flex min-h-[calc(100dvh-env(safe-area-inset-top))]">
          <div className="m-auto w-full max-w-sm space-y-6 py-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
