import { useEffect, useState } from 'react';
import { deviceKind } from '@/lib/device';

const MOBILE_QUERY = '(max-width: 767px)';

// "Mobile" is the mobile-NATIVE tier: a narrow viewport on a TOUCH device.
// A desktop window squeezed below 768px (Slack-next-to-ex half screen) is the
// compact tier instead — desktop chrome, no drawer gestures, no sheets. Test
// setups pin the device kind to 'touch' so historical width-driven tests keep
// their meaning; see lib/device.ts.
function readMobileMatch() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_QUERY).matches && deviceKind() === 'touch';
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(readMobileMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(query.matches && deviceKind() === 'touch');
    update();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }
    query.addListener?.(update);
    return () => query.removeListener?.(update);
  }, []);

  return isMobile;
}
