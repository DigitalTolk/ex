import type { HapticsPlugin } from '@/lib/haptics';

export {};

declare global {
  // Window Controls Overlay (frameless desktop windows expose the traffic-light
  // / caption geometry here). Only `visible` is read — to detect that the OS
  // window controls overlay the top-left of the web content. Not in TS's DOM lib.
  interface Navigator {
    windowControlsOverlay?: { visible: boolean };
  }
  interface Window {
    __EX_DESKTOP__?: boolean;
    // Desktop-shell bridge reporting the OS Do-Not-Disturb / Focus state
    // (macOS Focus, Windows Focus Assist). The Electron wrapper's preload
    // exposes it (main process answers via macos-notification-state /
    // windows-notification-state, Slack/Mattermost-style). When present, the
    // app plays its own custom notification ping gated on this state instead
    // of delegating the sound to the OS notification. Absent in browser
    // tabs/PWA, where the OS notification owns the sound (the only
    // DnD-correct option without a native bridge).
    __EX_DND__?: () => boolean | Promise<boolean>;
    // Desktop-shell bridge asking the OS to flag the app as needing attention
    // (macOS dock bounce, Windows/Linux taskbar flash). Reserved for a BLOCKED
    // agent run waiting on the user's decision — a banner can be missed or
    // dismissed, and ordinary messages deliberately never use this, so the
    // signal keeps meaning "something is waiting on you". Fire-and-forget;
    // absent in browser tabs/PWA, where a banner is all the platform offers.
    __EX_ATTENTION__?: () => void;
    // Desktop-shell bridge that raises a NATIVE OS notification carrying the
    // agent gate's decision buttons (Approve / Reject, or the choices) — the
    // web Notification API has no action buttons, so this is the only way to
    // decide from the notification itself. Present only in the desktop app;
    // the shell relays the clicked verdict back as an 'ex:approval-decision'
    // DOM CustomEvent. Absent in browser tabs/PWA (they use the web banner).
    __EX_APPROVAL_NOTIFY__?: (payload: {
      approvalID: string;
      runID: string;
      title: string;
      body: string;
      choices?: string[];
    }) => void;
    // Desktop-shell bridge for the agent-runner token handoff: the SPA mints
    // a runner-scoped token (POST /api/v1/agents/runner-token) and hands it
    // to the Electron shell, which runs local agent harnesses with it.
    // Injected by the shell's chat preload; absent in browser tabs/PWA.
    __EX_AGENT_RUNNER__?: { provideToken: (token: string) => void };
    // Test-only override for lib/device.ts deviceKind(): the jsdom and
    // browser setups pin it so width-driven tests keep their historical
    // meaning; production never sets it.
    __EX_FORCE_DEVICE__?: 'touch' | 'desktop';
    Capacitor?: {
      isNativePlatform?: () => boolean;
      Plugins?: {
        ServerNavigation?: {
          resetServer?: () => Promise<void>;
        };
        Haptics?: HapticsPlugin;
        OneSignalCapacitor?: {
          login?: (args: { externalId: string }) => Promise<void>;
          addTags?: (args: { tags: Record<string, string> }) => Promise<void>;
          logout?: () => Promise<void>;
          removeTags?: (args: { keys: string[] }) => Promise<void>;
        };
      };
    };
  }
}
