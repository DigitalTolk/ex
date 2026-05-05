import { useEffect, useState } from 'react';

const MOBILE_QUERY = '(max-width: 767px)';

function readMobileMatch() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(readMobileMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(query.matches);
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
