import { describe, expect, it } from 'vitest';
import { isTextField, keyboardOverlap, readKeyboardHeight, TEXT_FIELD_SELECTOR } from './keyboard';

describe('keyboard helpers', () => {
  it('reads the keyboard height from the event or its detail', () => {
    expect(readKeyboardHeight(Object.assign(new Event('k'), { keyboardHeight: 300 }))).toBe(300);
    expect(readKeyboardHeight(new CustomEvent('k', { detail: { keyboardHeight: 280 } }))).toBe(280);
    expect(readKeyboardHeight(new Event('k'))).toBe(0);
  });

  it('counts only what the keyboard still overlaps after the window shrank', () => {
    expect(keyboardOverlap(300, 800, 800)).toBe(300);
    expect(keyboardOverlap(300, 800, 600)).toBe(100);
    expect(keyboardOverlap(300, 800, 400)).toBe(0);
    expect(keyboardOverlap(300, 800, 900)).toBe(300);
  });

  it('knows which elements raise the keyboard', () => {
    document.body.innerHTML = `
      <input id="i" /><textarea id="t"></textarea><select id="s"></select>
      <div id="ce" contenteditable="true"></div><div id="tb" role="textbox"></div>
      <button id="b"></button>`;
    for (const id of ['i', 't', 's', 'ce', 'tb']) expect(isTextField(document.getElementById(id))).toBe(true);
    expect(isTextField(document.getElementById('b'))).toBe(false);
    expect(isTextField(null)).toBe(false);
    expect(TEXT_FIELD_SELECTOR).toContain('[contenteditable=""]');
    document.body.innerHTML = '';
  });
});
