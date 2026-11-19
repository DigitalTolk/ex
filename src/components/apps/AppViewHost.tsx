import { lazy, Suspense } from 'react';
import { useAppViewStore } from '@/stores/app-view';

// The form's code loads the first time an app opens one: chats that never
// see a form never pay for it.
const AppViewDialog = lazy(() => import('./AppViewDialog'));

// AppViewHost shows the app form on top of this tab's stack, if any. Mounted
// once at the chat root; each form (view ID) starts fresh, from its draft
// when going Back to it.
export function AppViewHost() {
  const current = useAppViewStore((s) => s.stack.at(-1));
  const depth = useAppViewStore((s) => s.stack.length);
  if (!current) return null;
  return (
    <Suspense fallback={null}>
      <AppViewDialog key={current.view.id} event={current} depth={depth} />
    </Suspense>
  );
}
