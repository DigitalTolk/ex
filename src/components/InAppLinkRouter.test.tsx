import { describe, it, expect, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { InAppLinkRouter } from './InAppLinkRouter';

const ORIGIN = window.location.origin; // jsdom default: http://localhost:3000

let lastLocation = '';
function LocationProbe() {
  const loc = useLocation();
  useEffect(() => {
    lastLocation = loc.pathname + loc.search + loc.hash;
  }, [loc]);
  return null;
}

function renderWithLink(href: string, attrs: Record<string, string> = {}) {
  return render(
    <MemoryRouter initialEntries={['/start']}>
      <InAppLinkRouter />
      <a href={href} target="_blank" rel="noopener noreferrer" data-testid="link" {...attrs}>
        link
      </a>
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function click(el: Element, init: MouseEventInit = {}) {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  // The handler is a native document listener; wrap so any resulting router
  // navigation (React state update) is flushed before assertions.
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

describe('InAppLinkRouter', () => {
  beforeEach(() => {
    lastLocation = '';
  });

  it('routes a same-origin permalink in-app and prevents the new-tab default', () => {
    const { getByTestId } = renderWithLink(`${ORIGIN}/channel/service-status#msg-1`);
    const ev = click(getByTestId('link'));
    expect(ev.defaultPrevented).toBe(true);
    expect(lastLocation).toBe('/channel/service-status#msg-1');
  });

  it('leaves external links alone (no preventDefault, no navigation)', () => {
    const { getByTestId } = renderWithLink('https://example.com/page');
    const ev = click(getByTestId('link'));
    expect(ev.defaultPrevented).toBe(false);
    expect(lastLocation).toBe('/start');
  });

  it('ignores modified clicks so "open in new tab" still works', () => {
    const { getByTestId } = renderWithLink(`${ORIGIN}/channel/x#msg-2`);
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const ev = click(getByTestId('link'), init);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(lastLocation).toBe('/start');
  });

  it('ignores download links and anchors without an href', () => {
    const dl = renderWithLink(`${ORIGIN}/file`, { download: '' });
    const ev1 = click(dl.getByTestId('link'));
    expect(ev1.defaultPrevented).toBe(false);
    dl.unmount();

    const span = render(
      <MemoryRouter>
        <InAppLinkRouter />
        <a data-testid="nohref">no href</a>
      </MemoryRouter>,
    );
    const ev2 = click(span.getByTestId('nohref'));
    expect(ev2.defaultPrevented).toBe(false);
  });

  it('ignores clicks that are not on an anchor', () => {
    const { container } = render(
      <MemoryRouter>
        <InAppLinkRouter />
        <button data-testid="btn">x</button>
      </MemoryRouter>,
    );
    const ev = click(container.querySelector('[data-testid="btn"]')!);
    expect(ev.defaultPrevented).toBe(false);
  });
});
