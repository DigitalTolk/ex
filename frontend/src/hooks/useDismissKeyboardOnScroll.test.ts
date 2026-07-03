import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDismissKeyboardOnScroll } from './useDismissKeyboardOnScroll';

const mobileRef = { value: true };
vi.mock('./useIsMobile', () => ({ useIsMobile: () => mobileRef.value }));

beforeEach(() => {
  mobileRef.value = true;
});
afterEach(() => {
  document.body.innerHTML = '';
});

function fireTouchMove(target: EventTarget) {
  const ev = new Event('touchmove', { bubbles: true });
  Object.defineProperty(ev, 'target', { value: target });
  document.dispatchEvent(ev);
}

describe('useDismissKeyboardOnScroll', () => {
  it('blurs the focused input when the move is outside it', () => {
    const input = document.createElement('input');
    const elsewhere = document.createElement('div');
    document.body.append(input, elsewhere);
    renderHook(() => useDismissKeyboardOnScroll());
    input.focus();
    fireTouchMove(elsewhere);
    expect(document.activeElement).not.toBe(input);
  });

  it('leaves the keyboard up when the move is inside the focused field', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useDismissKeyboardOnScroll());
    input.focus();
    fireTouchMove(input);
    expect(document.activeElement).toBe(input);
  });

  it('does nothing when no editable element is focused', () => {
    const btn = document.createElement('button');
    const elsewhere = document.createElement('div');
    document.body.append(btn, elsewhere);
    renderHook(() => useDismissKeyboardOnScroll());
    btn.focus();
    fireTouchMove(elsewhere);
    expect(document.activeElement).toBe(btn);
  });

  it('leaves the keyboard up while scrolling the CodeMirror typeahead (body-portalled)', () => {
    // The @mention / :emoji: autocomplete tooltip portals to document.body,
    // so it is NOT contained by the focused editor — but scrolling it is part
    // of typing; blurring here dropped the keyboard AND closed the popup.
    // (input stands in for the CM contenteditable — jsdom can only focus
    // form controls; the hook treats both as editable.)
    const editor = document.createElement('input');
    const tooltip = document.createElement('div');
    tooltip.className = 'cm-tooltip cm-tooltip-autocomplete';
    const option = document.createElement('li');
    tooltip.appendChild(option);
    document.body.append(editor, tooltip);
    renderHook(() => useDismissKeyboardOnScroll());
    editor.focus();
    fireTouchMove(option);
    expect(document.activeElement).toBe(editor);
  });

  it('does not attach the listener on desktop', () => {
    mobileRef.value = false;
    const input = document.createElement('input');
    const elsewhere = document.createElement('div');
    document.body.append(input, elsewhere);
    renderHook(() => useDismissKeyboardOnScroll());
    input.focus();
    fireTouchMove(elsewhere);
    expect(document.activeElement).toBe(input);
  });
});
