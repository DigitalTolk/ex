import { useServerVersion } from '@/hooks/useServerVersion';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/Banner';

// Watches the server's deployed version and prompts the user to reload
// when a new build has rolled out. We deliberately don't auto-reload —
// the user might be mid-message — but the banner is sticky at the top
// of the viewport so it can't be missed.
export function UpdateBanner() {
  const { outdated } = useServerVersion();

  if (!outdated) return null;

  // Cache-bust the document URL so the browser fetches a fresh index.html
  // instead of reusing the bfcache. Replace any prior `v=…` so repeated
  // reloads don't append v=…&v=…&v=….
  /* istanbul ignore next -- assigning location.href would navigate the vitest browser tester page away mid-run, so this handler cannot be clicked in the Playwright suite; it is fully driven and graded by the jsdom (v8) suite in src/test/server-version.test.tsx, which stubs window.location */
  const reload = () => {
    const params = new URLSearchParams(window.location.search);
    params.set('v', String(Date.now()));
    window.location.href = `${window.location.pathname}?${params.toString()}`;
  };

  return (
    <Banner
      tone="warn"
      testId="update-banner"
      centered
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={reload}
          data-testid="update-banner-reload"
        >
          Reload
        </Button>
      }
    >
      New version available.
    </Banner>
  );
}
