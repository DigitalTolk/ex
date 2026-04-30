import { useServerVersion } from '@/hooks/useServerVersion';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/Banner';
import { RefreshCw } from 'lucide-react';

// Watches the server's deployed version and prompts the user to reload
// when a new build has rolled out. We deliberately don't auto-reload —
// the user might be mid-message — but the banner is sticky at the top
// of the viewport so it can't be missed.
export function UpdateBanner() {
  const { outdated } = useServerVersion();

  if (!outdated) return null;

  return (
    <Banner
      tone="warn"
      testId="update-banner"
      icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // Cache-bust the document URL so the browser fetches a fresh
            // index.html instead of reusing the bfcache. Replace any
            // prior `v=…` so repeated reloads don't append v=…&v=…&v=….
            const params = new URLSearchParams(window.location.search);
            params.set('v', String(Date.now()));
            window.location.href = `${window.location.pathname}?${params.toString()}`;
          }}
          data-testid="update-banner-reload"
        >
          Reload now
        </Button>
      }
    >
      A new version of <strong>ex</strong> has been deployed. Reload to pick up the latest changes.
    </Banner>
  );
}
