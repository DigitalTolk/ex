import { getCapacitorPlugin, isNativePlatform } from './capacitor';

export type HapticsPlugin = {
  impact?: (options?: { style?: 'HEAVY' | 'MEDIUM' | 'LIGHT' }) => Promise<void>;
};

function impact(style: 'MEDIUM' | 'LIGHT', vibrateMs: number) {
  if (isNativePlatform()) {
    const haptics = getCapacitorPlugin('Haptics');
    if (haptics?.impact) {
      void haptics.impact({ style }).catch(() => {});
      return;
    }
  }

  if (navigator.vibrate) {
    navigator.vibrate(vibrateMs);
  }
}

// The long press that opens the message sheet: a firm tick.
export function triggerMessageActionHaptic() {
  impact('MEDIUM', 10);
}

// A one-tap reaction from the sheet: a lighter tick, it is a smaller act.
export function triggerReactionHaptic() {
  impact('LIGHT', 5);
}
