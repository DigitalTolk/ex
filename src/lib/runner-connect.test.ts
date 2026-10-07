import { afterEach, describe, expect, it, vi } from 'vitest';
import { callbackUrl, parseConnectRequest, runnerConnectNav } from './runner-connect';

const STATE = 'AbCdEfGhIjKlMnOpQrStUv';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function params(over: Record<string, string | null> = {}): URLSearchParams {
  const base: Record<string, string | null> = { port: '43123', state: STATE, challenge: CHALLENGE, name: 'Alices-Mac', ...over };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) if (v !== null) p.set(k, v);
  return p;
}

describe('parseConnectRequest', () => {
  it('accepts what ex-runner sends', () => {
    expect(parseConnectRequest(params())).toEqual({ port: 43123, state: STATE, challenge: CHALLENGE, name: 'Alices-Mac' });
  });

  it('refuses a bad port, state or challenge', () => {
    for (const port of ['80', '65536', '12ab', '', '1e4', null]) {
      expect(parseConnectRequest(params({ port }))).toBeNull();
    }
    expect(parseConnectRequest(params({ state: 'short' }))).toBeNull();
    expect(parseConnectRequest(params({ state: null }))).toBeNull();
    expect(parseConnectRequest(params({ challenge: 'has spaces and more than sixteen' }))).toBeNull();
    expect(parseConnectRequest(params({ challenge: null }))).toBeNull();
  });

  it('caps the machine name and never leaves it empty', () => {
    expect(parseConnectRequest(params({ name: 'x'.repeat(100) }))?.name).toHaveLength(64);
    expect(parseConnectRequest(params({ name: '   ' }))?.name).toBe('this computer');
    expect(parseConnectRequest(params({ name: null }))?.name).toBe('this computer');
  });
});

describe('callbackUrl', () => {
  const req = { port: 43123, state: STATE, challenge: CHALLENGE, name: 'mac' };
  it('always targets 127.0.0.1 on the given port, carrying the state', () => {
    const ok = new URL(callbackUrl(req, { code: 'one-time' }));
    expect(ok.origin + ok.pathname).toBe('http://127.0.0.1:43123/callback');
    expect(Object.fromEntries(ok.searchParams)).toEqual({ code: 'one-time', state: STATE });
    const no = new URL(callbackUrl(req, { error: 'access_denied' }));
    expect(Object.fromEntries(no.searchParams)).toEqual({ error: 'access_denied', state: STATE });
  });
});

describe('runnerConnectNav', () => {
  const realLocation = window.location;
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('hands the tab to the local listener', () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
    runnerConnectNav.leaveFor('http://127.0.0.1:43123/callback?code=c&state=s');
    expect(assign).toHaveBeenCalledWith('http://127.0.0.1:43123/callback?code=c&state=s');
  });
});
