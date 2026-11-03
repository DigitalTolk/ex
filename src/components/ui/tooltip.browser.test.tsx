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

  // Regression: the browser saw the pointer enter only the inert element,
  // which the primitive's trigger replaced. A pointer that moved on before
  // the browser's next frame re-checked what was under it — a quick pass
  // over a status or a reaction — was never reported leaving the new
  // trigger, and the tooltip stayed open until a click. Below, the page gets
  // what the browser sends then: the hover, then the pointer elsewhere, and
  // no leave.
  describe('a hover that moves straight on', () => {
    async function renderPass() {
      const screen = await render(
        <TooltipProvider delay={0}>
          <div data-testid="away" style={{ position: 'fixed', left: 0, top: 0, width: 40, height: 40 }} />
          <Tooltip>
            <TooltipTrigger render={<span data-testid="pass-trigger" style={{ position: 'fixed', right: 20, bottom: 20 }} />}>pass over me</TooltipTrigger>
            <TooltipContent>Pass body</TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      );
      const trigger = () => document.querySelector('[data-testid="pass-trigger"]') as HTMLElement;
      const away = document.querySelector('[data-testid="away"]') as HTMLElement;
      const hoverTrigger = () => trigger().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      const pointerAway = () => away.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
      return { screen, trigger, hoverTrigger, pointerAway };
    }
    const content = () => document.querySelector('[data-slot="tooltip-content"]');

    it('closes the tooltip it opened once the pointer turns up elsewhere', async () => {
      const { screen, hoverTrigger, pointerAway } = await renderPass();
      hoverTrigger();
      await expect.element(screen.getByText('Pass body').first()).toBeVisible();
      pointerAway();
      await expect.poll(content).toBeNull();
    });

    it('opens nothing when the pointer was gone before the hover reached the new trigger', async () => {
      const { trigger, hoverTrigger, pointerAway } = await renderPass();
      // Both before the replay (a microtask after this block).
      hoverTrigger();
      pointerAway();
      expect(trigger().hasAttribute('id')).toBe(true);
      await new Promise((r) => setTimeout(r, 150));
      expect(content()).toBeNull();
    });

    it('leaves the closing to the browser once it has the pointer on the new trigger, or when it left the window', async () => {
      const { screen, trigger, hoverTrigger } = await renderPass();
      hoverTrigger();
      // The browser re-checked and found the pointer on the trigger: it
      // reports the leave itself from here.
      trigger().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await expect.element(screen.getByText('Pass body').first()).toBeVisible();
      // A move between two elements says nothing; leaving the window does.
      document.body.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      await expect.element(screen.getByText('Pass body').first()).toBeVisible();
      trigger().dispatchEvent(new MouseEvent('mouseleave'));
      await expect.poll(content).toBeNull();
    });

    it('closes when the pointer leaves the window straight from the hover', async () => {
      const { screen, hoverTrigger } = await renderPass();
      hoverTrigger();
      await expect.element(screen.getByText('Pass body').first()).toBeVisible();
      document.body.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
      await expect.poll(content).toBeNull();
    });

    // Regression: WebKit finishes the move that armed the tooltip after the
    // swap, and with its element gone sends the rest of it to the parent —
    // a pointermove there, though the pointer is still on the trigger. Read
    // as "elsewhere", it closed the tooltip that hover had just opened.
    it('keeps the tooltip open when the rest of the arming move reaches the parent', async () => {
      const { screen, trigger, hoverTrigger } = await renderPass();
      hoverTrigger();
      await expect.element(screen.getByText('Pass body').first()).toBeVisible();
      const leaves: Event[] = [];
      trigger().addEventListener('mouseleave', (e) => leaves.push(e));
      const r = trigger().getBoundingClientRect();
      const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      const parent = trigger().parentElement as HTMLElement;
      parent.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse', ...at }));
      parent.dispatchEvent(new MouseEvent('mouseenter', at));
      parent.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', ...at }));
      expect(leaves).toEqual([]);
      await expect.element(screen.getByText('Pass body').first()).toBeVisible();
    });

    it('opens as before when the pointer moved within the new trigger before the replay', async () => {
      const { screen, trigger, hoverTrigger } = await renderPass();
      hoverTrigger();
      trigger().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
      await expect.element(screen.getByText('Pass body').first()).toBeVisible();
    });
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

  it('a tap never arms the tooltip, so nothing opens and no mouse is faked', async () => {
    const onPointerEnter = vi.fn();
    const screen = await render(
      <TooltipProvider delay={0}>
        {/* The test browser's one real pointer rests wherever an earlier test
            left it; park it top-left, with the triggers pinned bottom-right,
            so nothing mounts under it and hovers by accident. */}
        <div data-testid="park" style={{ position: 'fixed', left: 0, top: 0, width: 8, height: 8 }} />
        <Tooltip>
          <TooltipTrigger render={<span data-testid="touch-trigger" onPointerEnter={onPointerEnter} style={{ position: 'fixed', right: 0, bottom: 0 }} />}>tap me</TooltipTrigger>
          <TooltipContent>Touch body</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<span data-testid="late-trigger" style={{ position: 'fixed', right: 0, bottom: 40 }} />}>tap me too</TooltipTrigger>
          <TooltipContent>Late body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await userEvent.hover(screen.getByTestId('park'));
    // The app's pointer-device detection latches on any "mouse" pointerover
    // reaching the window; a tap must never produce one.
    const mouseOvers: string[] = [];
    const spy = (e: Event) => { if ((e as globalThis.PointerEvent).pointerType === 'mouse') mouseOvers.push(e.type); };
    window.addEventListener('pointerover', spy, true);
    try {
      const trigger = document.querySelector('[data-testid="touch-trigger"]') as HTMLElement;
      // What a tap does on a phone: a touch pointerover, then the replayed mouseover.
      trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' }));
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      // A tap whose pointer events missed the trigger (rows ignore pointers
      // while the list scrolls; a row can mount under the finger) reaches it
      // only as the replayed mouseover.
      const late = document.querySelector('[data-testid="late-trigger"]') as HTMLElement;
      late.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      expect(onPointerEnter).toHaveBeenCalled();
      // Still inert (the primitive's trigger would carry its id), nothing
      // opened and no mouse was faked.
      expect((document.querySelector('[data-testid="touch-trigger"]') as HTMLElement).hasAttribute('id')).toBe(false);
      expect((document.querySelector('[data-testid="late-trigger"]') as HTMLElement).hasAttribute('id')).toBe(false);
      expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
      expect(mouseOvers).toEqual([]);
    } finally {
      window.removeEventListener('pointerover', spy, true);
    }
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
