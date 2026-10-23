import { useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Toaster as Sonner } from 'sonner';
import { BANNER_TOASTER_ID, clearToasts } from '@/lib/toast';

// The app's toasts (see @/lib/toast): sonner places, stacks, times and
// removes them. Mounted once at the app root, portalled to <body> so no
// transformed ancestor can pin it, and above every overlay: sonner's own
// z-index outranks the lightbox (100), the mobile action sheet (120) and the
// body-portalled popovers/typeahead (1000).
//
// Two stacks: notification banners drop from the TOP, OS-style, clearing the
// notch/status bar; plain toasts sit bottom-center near the action that raised
// them, clearing the home indicator. Every toast in a stack stays visible
// (expand, no cap), and no hotkey moves focus into them.
const STACK = { expand: true, visibleToasts: Infinity, hotkey: [] as string[], gap: 8 };
const SIDES = { left: '1rem', right: '1rem' };
const TOP = 'calc(env(safe-area-inset-top) + 0.75rem)';
const BOTTOM = 'calc(env(safe-area-inset-bottom) + 1rem)';

export function Toaster() {
  useEffect(() => clearToasts, []);
  return createPortal(
    <>
      <Sonner
        {...STACK}
        id={BANNER_TOASTER_ID}
        position="top-center"
        offset={{ top: TOP }}
        mobileOffset={{ ...SIDES, top: TOP }}
        // The banner's own box is w-full up to max-w-md (28rem); sonner sizes
        // only its own styled toasts, so the slot is stretched here.
        style={{ '--width': '28rem' } as CSSProperties}
        toastOptions={{ className: 'w-full' }}
        customAriaLabel="Notifications"
      />
      <Sonner
        {...STACK}
        position="bottom-center"
        offset={{ bottom: BOTTOM }}
        mobileOffset={{ ...SIDES, bottom: BOTTOM }}
        // A plain toast is max-w-sm (24rem) and hugs its content.
        style={{ '--width': '24rem' } as CSSProperties}
        toastOptions={{ className: 'pointer-events-none w-full' }}
        customAriaLabel="Alerts"
      />
    </>,
    document.body,
  );
}
