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
