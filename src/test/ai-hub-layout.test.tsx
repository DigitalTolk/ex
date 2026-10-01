import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AiHubLayout from '@/pages/AiHubLayout';
import { AI_HUB_TABS, isAiHubPath } from '@/lib/ai-hub';

function renderAt(path: string) {
  return render(
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
    </MemoryRouter>,
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

  it('isAiHubPath covers the three pages and their sub-paths only', () => {
    expect(isAiHubPath('/agents')).toBe(true);
    expect(isAiHubPath('/skills')).toBe(true);
    expect(isAiHubPath('/connectors/cliffhub')).toBe(true);
    expect(isAiHubPath('/agentsx')).toBe(false);
    expect(isAiHubPath('/activity')).toBe(false);
  });
});
