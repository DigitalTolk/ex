import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isKeyboardModality, resetInputModalityForTests, startInputModalityTracking } from './input-modality';

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}
function click() {
  window.dispatchEvent(new Event('pointerdown'));
}

describe('input modality', () => {
  let button: HTMLButtonElement;
  let field: HTMLInputElement;
  beforeEach(() => {
    vi.useFakeTimers();
    startInputModalityTracking();
    startInputModalityTracking(); // idempotent
    resetInputModalityForTests();
    button = document.createElement('button');
    field = document.createElement('input');
    document.body.append(button, field);
  });
  afterEach(() => {
    button.remove();
    field.remove();
    vi.useRealTimers();
  });

  it('a navigating key is keyboard, a pointer press is not, and bare modifiers and Escape change nothing', () => {
    expect(isKeyboardModality()).toBe(false);
    press('Tab');
    expect(isKeyboardModality()).toBe(true);
    press('Escape');
    press('Shift');
    expect(isKeyboardModality()).toBe(true);
    click();
    expect(isKeyboardModality()).toBe(false);
    press('Shift');
    press('Escape');
    expect(isKeyboardModality()).toBe(false);
  });

  // The reported focus ring: Escape after a click made the clicked button
  // look keyboard-focused.
  it('lets go of a clicked control on Escape, but never of a text field', () => {
    click();
    button.focus();
    press('Escape');
    vi.runAllTimers();
    expect(document.activeElement).not.toBe(button);

    click();
    field.focus();
    press('Escape');
    vi.runAllTimers();
    expect(document.activeElement).toBe(field);
  });

  it('keeps the focus a keyboard user gave, and does nothing before any input', () => {
    press('Tab');
    button.focus();
    press('Escape');
    vi.runAllTimers();
    expect(document.activeElement).toBe(button);

    resetInputModalityForTests();
    button.focus();
    press('Escape');
    vi.runAllTimers();
    expect(document.activeElement).toBe(button);
  });

  // A menu or dialog closing hands focus back to its trigger after its exit
  // animation: that focus is let go once, within a short window.
  it('lets go of focus handed back shortly after Escape, once', () => {
    click();
    press('Escape');
    vi.runAllTimers();
    button.focus();
    expect(document.activeElement).not.toBe(button);
    // Once only: a focus trap pulling it back keeps it.
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('a focus long after Escape is left alone', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    click();
    press('Escape');
    vi.runAllTimers();
    now.mockReturnValue(3000);
    button.focus();
    expect(document.activeElement).toBe(button);
    now.mockRestore();
  });
});
