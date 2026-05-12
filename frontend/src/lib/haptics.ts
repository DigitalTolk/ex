type HapticsPlugin = {
  impact?: (options?: { style?: 'HEAVY' | 'MEDIUM' | 'LIGHT' }) => Promise<void>;
  selectionStart?: () => Promise<void>;
  selectionChanged?: () => Promise<void>;
  selectionEnd?: () => Promise<void>;
};

function hapticsPlugin(): HapticsPlugin | undefined {
  if (!window.Capacitor?.isNativePlatform?.()) return undefined;
  return window.Capacitor.Plugins?.Haptics;
}

export function triggerMessageActionHaptic() {
  const haptics = hapticsPlugin();
  if (haptics?.impact) {
    void haptics.impact({ style: 'MEDIUM' }).catch(() => {});
    return;
  }

  if (navigator.vibrate) {
    navigator.vibrate(10);
  }
}
