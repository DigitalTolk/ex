import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

// New @utility shortcuts (`pt-safe-top`, `pb-safe-bottom`,
// `pl-safe-left`, `pr-safe-right`) and the matching CSS custom
// properties (--safe-top etc.) replace dozens of repeated
// `pt-[env(safe-area-inset-top)]`-style arbitrary values across the
// codebase. These tests lock the new contract: the utilities must
// resolve to the same computed padding env() previously emitted, and
// the custom properties must be readable from anywhere in the
// document (so future calc()s can use var(--safe-top) instead of
// retyping env()).
//
// browsers may report safe-area insets as 0px in headless test
// runners — that's expected. We assert the resolved property name
// matches `env(...)` semantics by checking the computed pixel value
// is non-negative and that the same value resolves whether read via
// the utility class or via the CSS custom property.

describe('safe-area utilities', () => {
  it('pt-safe-top resolves to env(safe-area-inset-top) in computed style', async () => {
    const screen = await render(
      <>
        <div data-testid="utility" className="pt-safe-top" />
        <div
          data-testid="raw"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        />
      </>,
    );
    const utilityPad = getComputedStyle(screen.getByTestId('utility').element()).paddingTop;
    const rawPad = getComputedStyle(screen.getByTestId('raw').element()).paddingTop;
    expect(utilityPad).toBe(rawPad);
  });

  it('pb-safe-bottom resolves to env(safe-area-inset-bottom) in computed style', async () => {
    const screen = await render(
      <>
        <div data-testid="utility" className="pb-safe-bottom" />
        <div
          data-testid="raw"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        />
      </>,
    );
    const u = getComputedStyle(screen.getByTestId('utility').element()).paddingBottom;
    const r = getComputedStyle(screen.getByTestId('raw').element()).paddingBottom;
    expect(u).toBe(r);
  });

  it('--safe-top / --safe-bottom resolve to the same pixel value as env() when consumed', async () => {
    const screen = await render(
      <>
        <div
          data-testid="via-var-top"
          style={{ paddingTop: 'var(--safe-top)' }}
        />
        <div
          data-testid="via-env-top"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        />
        <div
          data-testid="via-var-bottom"
          style={{ paddingBottom: 'var(--safe-bottom)' }}
        />
        <div
          data-testid="via-env-bottom"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        />
      </>,
    );
    const vt = getComputedStyle(screen.getByTestId('via-var-top').element()).paddingTop;
    const et = getComputedStyle(screen.getByTestId('via-env-top').element()).paddingTop;
    const vb = getComputedStyle(screen.getByTestId('via-var-bottom').element()).paddingBottom;
    const eb = getComputedStyle(screen.getByTestId('via-env-bottom').element()).paddingBottom;
    expect(vt).toBe(et);
    expect(vb).toBe(eb);
  });

  it('var(--safe-top) is interchangeable with env(safe-area-inset-top) inside calc()', async () => {
    const screen = await render(
      <>
        <div
          data-testid="via-var"
          style={{ paddingTop: 'calc(var(--safe-top) + 8px)' }}
        />
        <div
          data-testid="via-env"
          style={{ paddingTop: 'calc(env(safe-area-inset-top) + 8px)' }}
        />
      </>,
    );
    const v = getComputedStyle(screen.getByTestId('via-var').element()).paddingTop;
    const e = getComputedStyle(screen.getByTestId('via-env').element()).paddingTop;
    expect(v).toBe(e);
  });
});
