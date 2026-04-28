import { useServerVersion } from '@/hooks/useServerVersion';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

// UpdateBanner watches the server's deployed version and prompts the
// user to reload when a new build has rolled out. We deliberately don't
// auto-reload — the user might be mid-message — but the banner is sticky
// at the top of the viewport so it can't be missed.
export function UpdateBanner() {
  const { outdated } = useServerVersion();

  if (!outdated) return null;

  return (
    <div
      role="alert"
      data-testid="update-banner"
      className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100"
    >
      <div className="flex items-center gap-2">
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        <span>
          A new version of <strong>ex</strong> has been deployed. Reload to pick up the latest changes.
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          // Cache-busting the document URL forces the browser to fetch
          // a fresh index.html instead of reusing whatever the back/
          // forward cache holds.
          const sep = window.location.search ? '&' : '?';
          window.location.href = `${window.location.pathname}${window.location.search}${sep}v=${Date.now()}`;
        }}
        data-testid="update-banner-reload"
      >
        Reload now
      </Button>
    </div>
  );
}
