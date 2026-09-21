import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  HARDWARE_KEYBOARD_EVENT,
  useAutoFocusTextInput,
  useHardwareKeyboard,
  useSubmitOnEnter,
} from './useHardwareKeyboard';

const mobileRef = { value: false };
vi.mock('./useIsMobile', () => ({ useIsMobile: () => mobileRef.value }));

function report(connected: boolean) {
  window.__EX_HARDWARE_KEYBOARD__ = connected;
  window.dispatchEvent(new CustomEvent(HARDWARE_KEYBOARD_EVENT, { detail: { connected } }));
}

afterEach(() => {
  delete window.__EX_HARDWARE_KEYBOARD__;
  mobileRef.value = false;
});

describe('useHardwareKeyboard', () => {
  it('is null when no native shell reports keyboard state', () => {
    const { result } = renderHook(() => useHardwareKeyboard());

    expect(result.current).toBeNull();
  });

  it('reads the state the shell already reported before mount', () => {
    window.__EX_HARDWARE_KEYBOARD__ = true;
    const { result } = renderHook(() => useHardwareKeyboard());

    expect(result.current).toBe(true);
  });

  it('follows keyboard attach and detach events, and stops listening on unmount', () => {
    const { result, unmount } = renderHook(() => useHardwareKeyboard());

    act(() => report(true));
    expect(result.current).toBe(true);
    act(() => report(false));
    expect(result.current).toBe(false);

    unmount();
    act(() => report(true));
    expect(result.current).toBe(false);
  });
});

describe('useSubmitOnEnter', () => {
  it.each([
    // [isMobile, reported hardware keyboard, Enter submits]
    [true, undefined, false],
    [false, undefined, true],
    [true, true, true],
    [false, false, false],
  ])('isMobile=%s, hardware keyboard=%s → submits=%s', (isMobile, hardwareKeyboard, submits) => {
    mobileRef.value = isMobile;
    if (hardwareKeyboard !== undefined) window.__EX_HARDWARE_KEYBOARD__ = hardwareKeyboard;
    const { result } = renderHook(() => useSubmitOnEnter());

    expect(result.current).toBe(submits);
  });
});

describe('useAutoFocusTextInput', () => {
  it.each([
    // [isMobile, reported hardware keyboard, autofocus]
    [false, undefined, true],
    [true, undefined, false],
    [true, true, false],
    [false, true, true],
    [false, false, false],
  ])('isMobile=%s, hardware keyboard=%s → autofocus=%s', (isMobile, hardwareKeyboard, autoFocus) => {
    mobileRef.value = isMobile;
    if (hardwareKeyboard !== undefined) window.__EX_HARDWARE_KEYBOARD__ = hardwareKeyboard;
    const { result } = renderHook(() => useAutoFocusTextInput());

    expect(result.current).toBe(autoFocus);
  });

  it('turns autofocus back on when a hardware keyboard is attached', () => {
    window.__EX_HARDWARE_KEYBOARD__ = false;
    const { result } = renderHook(() => useAutoFocusTextInput());
    expect(result.current).toBe(false);

    act(() => report(true));
    expect(result.current).toBe(true);
  });
});
