import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { Banner } from './Banner';

describe('Banner browser behaviour', () => {
  it('renders with role="alert" and the testId', async () => {
    await render(<Banner tone="info" testId="my-banner">hello</Banner>);
    const el = document.querySelector('[data-testid="my-banner"]') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.getAttribute('role')).toBe('alert');
  });

  it('applies the info tone classes by default', async () => {
    await render(<Banner tone="info">x</Banner>);
    const banner = document.querySelector('[role="alert"]') as HTMLElement;
    expect(banner.className).toMatch(/sky/);
  });

  it('applies the warn tone classes', async () => {
    await render(<Banner tone="warn">x</Banner>);
    const banner = document.querySelector('[role="alert"]') as HTMLElement;
    expect(banner.className).toMatch(/amber/);
  });

  it('renders actions when supplied', async () => {
    await render(
      <Banner tone="info" actions={<button data-testid="act">do</button>}>x</Banner>,
    );
    expect(document.querySelector('[data-testid="act"]')).not.toBeNull();
  });

  it('renders an icon slot when supplied', async () => {
    await render(
      <Banner tone="info" icon={<span data-testid="icon">!</span>}>x</Banner>,
    );
    expect(document.querySelector('[data-testid="icon"]')).not.toBeNull();
  });

  it('uses the centered three-column layout when centered=true', async () => {
    await render(<Banner tone="info" centered>x</Banner>);
    const banner = document.querySelector('[role="alert"]') as HTMLElement;
    expect(banner.className).toMatch(/grid/);
  });

  it('uses the flex layout (non-centered) by default', async () => {
    await render(<Banner tone="info">x</Banner>);
    const banner = document.querySelector('[role="alert"]') as HTMLElement;
    expect(banner.className).toMatch(/flex/);
    expect(banner.className).not.toMatch(/grid/);
  });

  it('omits the actions wrapper when no actions are supplied (non-centered)', async () => {
    await render(<Banner tone="info">x</Banner>);
    const banner = document.querySelector('[role="alert"]') as HTMLElement;
    // In non-centered mode, the actions slot is rendered as null.
    expect(banner.querySelector('[data-testid]')).toBeNull();
  });
});
