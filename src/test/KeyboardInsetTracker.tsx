import { useKeyboardInsetTracker } from '@/hooks/useKeyboardInset';

// The app's keyboard inset tracker, mounted once at the app root in App.tsx.
export function KeyboardInsetTracker() {
  useKeyboardInsetTracker();
  return null;
}
