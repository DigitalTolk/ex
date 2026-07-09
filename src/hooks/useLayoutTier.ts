import { useEffect, useState } from 'react';
import { currentLayoutTier, type LayoutTier } from '@/lib/device';

// useLayoutTier is the JS side of the three-tier layout model (mobile /
// compact / full). It reads the same predicate that stamps the root tier
// classes for the CSS variants, so components can never disagree with their
// own styling about which tier they're in.
export function useLayoutTier(): LayoutTier {
  const [tier, setTier] = useState<LayoutTier>(() => currentLayoutTier());

  useEffect(() => {
    const onResize = () => setTier(currentLayoutTier());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return tier;
}
