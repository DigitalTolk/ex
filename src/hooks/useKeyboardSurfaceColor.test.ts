import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardSurfaceColor } from './useKeyboardSurfaceColor';

const KEY = '--ex-keyboard-background';

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(KEY);
  document.body.innerHTML = '';
});

function mockComputed(value: string) {
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: () => value,
  } as unknown as CSSStyleDeclaration);
}

describe('useKeyboardSurfaceColor', () => {
  it('hoists the focused field surface colour onto the document root', () => {
    mockComputed('rgb(10, 20, 30)');
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useKeyboardSurfaceColor());

    input.focus();
    document.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(document.documentElement.style.getPropertyValue(KEY)).toBe('rgb(10, 20, 30)');
  });

  it('clears the override when focus leaves all fields', () => {
    mockComputed('rgb(1, 2, 3)');
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useKeyboardSurfaceColor());

    input.focus();
    document.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.documentElement.style.getPropertyValue(KEY)).toBe('rgb(1, 2, 3)');

    input.blur();
    document.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(document.documentElement.style.getPropertyValue(KEY)).toBe('');
  });

  it('removes the override when the focused field has no resolved colour', () => {
    mockComputed('   ');
    const input = document.createElement('input');
    document.body.appendChild(input);
    document.documentElement.style.setProperty(KEY, 'rgb(9, 9, 9)');
    renderHook(() => useKeyboardSurfaceColor());

    input.focus();
    document.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(document.documentElement.style.getPropertyValue(KEY)).toBe('');
  });

  it('ignores focus on non-field elements', () => {
    mockComputed('rgb(5, 5, 5)');
    const div = document.createElement('div');
    div.tabIndex = 0;
    document.body.appendChild(div);
    renderHook(() => useKeyboardSurfaceColor());

    div.focus();
    document.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(document.documentElement.style.getPropertyValue(KEY)).toBe('');
  });

  it('drops the override on unmount', () => {
    mockComputed('rgb(7, 7, 7)');
    const input = document.createElement('input');
    document.body.appendChild(input);
    const { unmount } = renderHook(() => useKeyboardSurfaceColor());
    input.focus();
    document.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.documentElement.style.getPropertyValue(KEY)).toBe('rgb(7, 7, 7)');

    unmount();
    expect(document.documentElement.style.getPropertyValue(KEY)).toBe('');
  });
});
