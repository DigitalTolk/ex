import { describe, it, expect, afterEach } from 'vitest';
import { blurActiveInput } from './blur-input';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('blurActiveInput', () => {
  it('blurs a focused input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    blurActiveInput();
    expect(document.activeElement).not.toBe(input);
  });

  it('blurs a focused textarea and contenteditable', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    blurActiveInput();
    expect(document.activeElement).not.toBe(ta);

    const ce = document.createElement('div');
    ce.tabIndex = 0;
    // jsdom doesn't implement isContentEditable; stub it so the branch runs.
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    document.body.appendChild(ce);
    ce.focus();
    expect(document.activeElement).toBe(ce);
    blurActiveInput();
    expect(document.activeElement).not.toBe(ce);
  });

  it('is a no-op when a non-editable element is focused', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
    blurActiveInput();
    expect(document.activeElement).toBe(btn);
  });
});
