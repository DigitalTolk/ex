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
    // Set by the ex-mobile iOS shell: true while typing comes from a hardware
    // keyboard, false while it goes through the on-screen keyboard. Absent
    // everywhere else. See hooks/useHardwareKeyboard.ts.
    __EX_HARDWARE_KEYBOARD__?: boolean;
    // Set by the ex-mobile iOS shell: true while a mouse or trackpad (iPad
    // Magic Keyboard) is attached. Absent everywhere else — lib/device.ts then
    // falls back to watching for real mouse input.
    __EX_POINTER_DEVICE__?: boolean;
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
