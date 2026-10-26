import { lazy, Suspense, type ComponentProps } from 'react';
import type { ReminderDialog } from '@/components/chat/ReminderDialog';

// The date-and-time picker (react-day-picker + date-fns) loads the first time
// a picker opens — the message menu's "Custom…", the composer's scheduled
// send, an Activity row — instead of shipping with the message list. Every
// opener mounts this only while the picker is open, so the boundary here
// keeps a first open's load from suspending anything around it.
const ReminderDialogChunk = lazy(() =>
  import('@/components/chat/ReminderDialog').then((m) => ({ default: m.ReminderDialog })),
);

export function LazyReminderDialog(props: ComponentProps<typeof ReminderDialog>) {
  return (
    <Suspense fallback={null}>
      <ReminderDialogChunk {...props} />
    </Suspense>
  );
}
