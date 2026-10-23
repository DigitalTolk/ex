import { describe, it, expect, vi, afterEach } from 'vitest';
import { navigateInApp } from './navigate-in-app';

describe('navigateInApp', () => {
  const start = window.location.pathname + window.location.search + window.location.hash;
  const realLocation = window.location;

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    window.history.replaceState(null, '', start);
  });

  // A stand-in location for the cross-origin arm: a real one would navigate
  // the test page away.
  function stubLocation() {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, origin: realLocation.origin, assign },
    });
    return assign;
  }

  it('routes a same-origin link through the router, without a reload', () => {
    const onPop = vi.fn();
    window.addEventListener('popstate', onPop);
    try {
      navigateInApp('/channel/general?x=1#msg-1');
      expect(window.location.pathname + window.location.search + window.location.hash).toBe(
        '/channel/general?x=1#msg-1',
      );
      navigateInApp(`${window.location.origin}/conversation/c-1`);
      expect(window.location.pathname).toBe('/conversation/c-1');
      expect(onPop).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener('popstate', onPop);
    }
  });

  it('follows a link to another origin only when it is plain http(s)', () => {
    const assign = stubLocation();
    navigateInApp('https://status.example.com/incident/7');
    expect(assign).toHaveBeenCalledWith('https://status.example.com/incident/7');
    for (const href of ['javascript:alert(1)', 'data:text/html,<p>x</p>', 'smb://attacker.example/share', 'ms-msdt:/id x', 'file:///etc/passwd']) {
      navigateInApp(href);
    }
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('does nothing with a link that does not parse', () => {
    const assign = stubLocation();
    const push = vi.spyOn(window.history, 'pushState');
    navigateInApp('http://[');
    expect(assign).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });
});
