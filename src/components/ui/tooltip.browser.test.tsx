import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

// Browser coverage for the Tooltip primitive's default parameters —
// TooltipProvider's `delay = 0` and TooltipContent's `side`/`align`/
// offset defaults are otherwise never exercised because every in-app
// caller passes explicit values.

describe('Tooltip primitive defaults', () => {
  it('renders a tooltip using the provider/content default parameters', async () => {
    const screen = await render(
      // No `delay` on the provider (→ delay=0 default) and no side/align/
      // offset props on the content (→ side="top", align="center",
      // sideOffset=4, alignOffset=0 defaults).
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger data-testid="tt-trigger">hover me</TooltipTrigger>
          <TooltipContent>Tooltip body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await expect.element(screen.getByTestId('tt-trigger')).toBeVisible();
    // The popup content is portalled to the body when open.
    await expect.element(screen.getByText('Tooltip body').first()).toBeVisible();
  });

  it('mounts the primitive only on first hover, and the tooltip opens from that same hover', async () => {
    const onMouseEnter = vi.fn();
    const screen = await render(
      <TooltipProvider delay={0}>
        <Tooltip>
          <TooltipTrigger render={<span data-testid="lazy-trigger" onMouseEnter={onMouseEnter} className="own" />} className="extra">
            hover me
          </TooltipTrigger>
          <TooltipContent>Lazy body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = document.querySelector('[data-testid="lazy-trigger"]') as HTMLElement;
    // Inert: the span itself, with both class names, and no primitive root.
    expect(trigger.tagName).toBe('SPAN');
    expect(trigger.getAttribute('data-slot')).toBe('tooltip-trigger');
    expect(trigger.className).toBe('own extra');
    // The primitive's trigger would carry its generated id; the inert one has none.
    expect(trigger.hasAttribute('id')).toBe(false);
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();

    await userEvent.hover(screen.getByTestId('lazy-trigger'));
    expect(onMouseEnter).toHaveBeenCalled();
    await expect.element(screen.getByText('Lazy body').first()).toBeVisible();
    expect((document.querySelector('[data-testid="lazy-trigger"]') as HTMLElement).hasAttribute('id')).toBe(true);
  });

  it('mounts on keyboard focus and keeps focus on the real trigger', async () => {
    const onFocus = vi.fn();
    const screen = await render(
      <TooltipProvider delay={0}>
        <Tooltip>
          <TooltipTrigger render={<button type="button" data-testid="focus-trigger" onFocus={onFocus} />}>focus me</TooltipTrigger>
          <TooltipContent>Focus body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    (document.querySelector('[data-testid="focus-trigger"]') as HTMLElement).focus();
    expect(onFocus).toHaveBeenCalled();
    // The real trigger takes over the focus, and opens from it.
    await expect.element(screen.getByText('Focus body').first()).toBeVisible();
    const real = document.querySelector('[data-testid="focus-trigger"]') as HTMLElement;
    expect(real.hasAttribute('id')).toBe(true);
    expect(document.activeElement).toBe(real);
  });

  it('a touch contact mounts the primitive without replaying a mouse, so touch affordances stay', async () => {
    const onPointerEnter = vi.fn();
    const screen = await render(
      <TooltipProvider delay={0}>
        {/* The test browser's one real pointer rests wherever an earlier test
            left it; park it top-left, with the trigger pinned bottom-right,
            so nothing mounts under it and hovers by accident. */}
        <div data-testid="park" style={{ position: 'fixed', left: 0, top: 0, width: 8, height: 8 }} />
        <Tooltip>
          <TooltipTrigger render={<span data-testid="touch-trigger" onPointerEnter={onPointerEnter} style={{ position: 'fixed', right: 0, bottom: 0 }} />}>tap me</TooltipTrigger>
          <TooltipContent>Touch body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await userEvent.hover(screen.getByTestId('park'));
    // The app's pointer-device detection latches on any "mouse" pointerover
    // reaching the window; a tap must never produce one.
    const mouseOvers: string[] = [];
    const spy = (e: Event) => { if ((e as globalThis.PointerEvent).pointerType === 'mouse') mouseOvers.push(e.type); };
    window.addEventListener('pointerover', spy, true);
    const trigger = document.querySelector('[data-testid="touch-trigger"]') as HTMLElement;
    // What a tap does on a phone: a touch pointerover, then the synthesized mouseover.
    trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' }));
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(onPointerEnter).toHaveBeenCalled();
    // Armed (the primitive's trigger carries its id) but nothing opened and
    // no mouse was faked.
    expect((document.querySelector('[data-testid="touch-trigger"]') as HTMLElement).hasAttribute('id')).toBe(true);
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    expect(mouseOvers).toEqual([]);
    window.removeEventListener('pointerover', spy, true);
  });

  it('renders a default button trigger while inert', async () => {
    await render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger data-testid="default-trigger">plain</TooltipTrigger>
          <TooltipContent>Body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = document.querySelector('[data-testid="default-trigger"]') as HTMLButtonElement;
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.type).toBe('button');
  });

  it('arms at once for a render function, and shows nothing for a root render function', async () => {
    await render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={(props) => <i {...props} data-testid="fn-trigger" />}>fn</TooltipTrigger>
          <TooltipContent>Body</TooltipContent>
        </Tooltip>
        <Tooltip>{() => <TooltipTrigger data-testid="never">no</TooltipTrigger>}</Tooltip>
      </TooltipProvider>,
    );
    await vi.waitFor(() => expect(document.querySelector('[data-testid="fn-trigger"][data-slot="tooltip-trigger"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="never"]')).toBeNull();
  });
});
