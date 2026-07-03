import { describe, expect, it, afterEach } from 'vitest';
import { blurActiveInput } from './blur-input';

// REAL-browser coverage for blurActiveInput. The jsdom unit test has to stub
// `isContentEditable` (jsdom doesn't implement it); a real browser gives us
// genuine focus + a real contenteditable, so every arm of the type guard is
// exercised with actual DOM behaviour. This file lets blur-input.ts be graded
// by the browser suite (removed from vitest.browser.config.ts's exclude).

afterEach(() => {
  document.body.innerHTML = '';
});

describe('blurActiveInput (real browser focus)', () => {
  it('blurs a focused <input>', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    blurActiveInput();
    expect(document.activeElement).not.toBe(input);
  });

  it('blurs a focused <textarea>', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    expect(document.activeElement).toBe(ta);
    blurActiveInput();
    expect(document.activeElement).not.toBe(ta);
  });

  it('blurs a focused contenteditable element', () => {
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    document.body.appendChild(ce);
    ce.focus();
    expect(document.activeElement).toBe(ce);
    expect(ce.isContentEditable).toBe(true);
    blurActiveInput();
    expect(document.activeElement).not.toBe(ce);
  });

  it('is a no-op when a non-editable element is focused', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
    expect(document.activeElement).toBe(btn);
    blurActiveInput();
    // Not an input/textarea/contenteditable → stays focused.
    expect(document.activeElement).toBe(btn);
  });

  it('is a no-op when nothing editable is focused (body active)', () => {
    // Nothing focused → activeElement is <body>, an HTMLElement whose tagName
    // matches none of the editable cases: the guard short-circuits to no-op.
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(() => blurActiveInput()).not.toThrow();
  });

  it('is a no-op when the active element is not an HTMLElement (focused SVG)', () => {
    // A focusable SVG element's activeElement is an SVGElement, not an
    // HTMLElement, so the `instanceof HTMLElement` guard is false.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('tabindex', '0');
    document.body.appendChild(svg);
    (svg as unknown as { focus: () => void }).focus();
    expect(() => blurActiveInput()).not.toThrow();
  });
});
