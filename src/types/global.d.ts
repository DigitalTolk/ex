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
