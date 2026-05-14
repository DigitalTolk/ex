import { getCapacitorPlugin, isNativePlatform } from './capacitor';

export type HapticsPlugin = {
  impact?: (options?: { style?: 'HEAVY' | 'MEDIUM' | 'LIGHT' }) => Promise<void>;
};

export function triggerMessageActionHaptic() {
  if (isNativePlatform()) {
    const haptics = getCapacitorPlugin('Haptics');
    if (haptics?.impact) {
      void haptics.impact({ style: 'MEDIUM' }).catch(() => {});
      return;
    }
  }

  if (navigator.vibrate) {
    navigator.vibrate(10);
  }
}
