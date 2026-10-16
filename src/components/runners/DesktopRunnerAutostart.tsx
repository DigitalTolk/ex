import { useDesktopRunnerAutostart } from '@/hooks/useDesktopRunner';

// DesktopRunnerAutostart renders nothing: it starts ex-runner when ex opens,
// if the person asked for that on the Runners tab. Mounted once at the chat
// root, and only inside the desktop app.
export function DesktopRunnerAutostart() {
  useDesktopRunnerAutostart();
  return null;
}
