import { lazy, Suspense } from 'react';
import { useAppViewStore } from '@/stores/app-view';

// The form's code loads the first time an app opens one: chats that never
// see a form never pay for it.
const AppViewDialog = lazy(() => import('./AppViewDialog'));

// AppViewHost shows the app form open in this tab, if any. Mounted once at
// the chat root; a new form (another view ID) starts fresh.
export function AppViewHost() {
  const current = useAppViewStore((s) => s.current);
  if (!current) return null;
  return (
    <Suspense fallback={null}>
      <AppViewDialog key={current.view.id} event={current} />
    </Suspense>
  );
}
