import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AiHubLayout from '@/pages/AiHubLayout';
import { AI_HUB_TABS, isAiHubPath, visibleAiHubTabs } from '@/lib/ai-hub';
import { queryKeys } from '@/lib/query-keys';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(() => new Promise(() => {})) }));

// runnersInApp is the workspace switch behind the Runners tab; most cases
// render with it on so every tab is present.
function renderAt(path: string, runnersInApp = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(queryKeys.workspaceSettings(), { maxUploadBytes: 0, allowedExtensions: [], runnersInApp });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {/* Stub one page per tab, derived from the source of truth so a new
              tab can't silently render into an empty layout. */}
          <Route element={<AiHubLayout />}>
            {AI_HUB_TABS.map(({ to }) => (
              <Route key={to} path={to} element={<div data-testid={`page-${to.slice(1)}`} />} />
            ))}
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AiHubLayout', () => {
  it.each(AI_HUB_TABS.map((t) => [t.to, t.label] as const))(
    'renders the tab strip with %s active and the page below it',
    (path, label) => {
      const view = renderAt(path);
      const nav = screen.getByRole('navigation', { name: 'AI sections' });
      const links = screen.getAllByRole('link');
      expect(links.map((l) => l.textContent)).toEqual(AI_HUB_TABS.map((t) => t.label));
      const active = screen.getByRole('link', { name: label });
      expect(active).toHaveAttribute('aria-current', 'page');
      expect(active.className).toContain('font-semibold');
      for (const other of links.filter((l) => l !== active)) {
        expect(other).not.toHaveAttribute('aria-current');
        expect(other.className).not.toContain('font-semibold');
      }
      expect(nav).toBeInTheDocument();
      expect(screen.getByTestId(`page-${path.slice(1)}`)).toBeInTheDocument();
      view.unmount();
    },
  );

  it('switches pages when a tab is clicked', () => {
    renderAt('/agents');
    fireEvent.click(screen.getByRole('link', { name: 'Connectors' }));
    expect(screen.getByTestId('page-connectors')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connectors' })).toHaveAttribute('aria-current', 'page');
  });

  it('hides the Runners tab until the workspace turns it on', () => {
    renderAt('/agents', false);
    const labels = screen.getAllByRole('link').map((l) => l.textContent);
    expect(labels).not.toContain('Runners');
    expect(labels).toEqual(visibleAiHubTabs(false).map((t) => t.label));
    expect(visibleAiHubTabs(true).map((t) => t.label)).toContain('Runners');
  });

  it('isAiHubPath covers the hub pages and their sub-paths only', () => {
    expect(isAiHubPath('/runners')).toBe(true);
    expect(isAiHubPath('/agents')).toBe(true);
    expect(isAiHubPath('/skills')).toBe(true);
    expect(isAiHubPath('/connectors/cliffhub')).toBe(true);
    expect(isAiHubPath('/agentsx')).toBe(false);
    expect(isAiHubPath('/activity')).toBe(false);
  });
});
