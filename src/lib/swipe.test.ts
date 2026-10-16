import { describe, it, expect } from 'vitest';
import { shouldCommitSwipe, swipeStartsOn } from './swipe';

describe('shouldCommitSwipe', () => {
  // A phone-wide panel: 35% of 390px is 136.5px.
  const travel = 390;

  // The reported bug: a slow swipe sprang back however far it went.
  it('commits a slow, deliberate swipe on distance alone', () => {
    expect(shouldCommitSwipe({ distance: 140, velocity: 0, travel })).toBe(true);
    expect(shouldCommitSwipe({ distance: 120, velocity: 0, travel })).toBe(false);
  });

  it('commits a short flick: the release is judged where it was heading', () => {
    expect(shouldCommitSwipe({ distance: 30, velocity: 900, travel })).toBe(true);
    expect(shouldCommitSwipe({ distance: 30, velocity: 200, travel })).toBe(false);
  });

  it('takes back a swipe that was heading back when let go', () => {
    expect(shouldCommitSwipe({ distance: 200, velocity: -600, travel })).toBe(false);
  });

  it('needs at least a minimum distance on a small sheet, and at most a maximum on a big panel', () => {
    // 35% of 120px would be 42px, a nudge: the floor is 64px.
    expect(shouldCommitSwipe({ distance: 50, velocity: 0, travel: 120 })).toBe(false);
    expect(shouldCommitSwipe({ distance: 64, velocity: 0, travel: 120 })).toBe(true);
    // 35% of 1024px would be 358px: the ceiling is 160px.
    expect(shouldCommitSwipe({ distance: 160, velocity: 0, travel: 1024 })).toBe(true);
  });
});

describe('swipeStartsOn', () => {
  function surface(kind = 'x') {
    const el = document.createElement('main');
    el.setAttribute('data-swipe-surface', kind);
    document.body.appendChild(el);
    return el;
  }

  it('starts anywhere on the surface itself', () => {
    const main = surface();
    const row = document.createElement('div');
    main.appendChild(row);
    expect(swipeStartsOn(row, main)).toBe(true);
    expect(swipeStartsOn(main, main)).toBe(true);
    main.remove();
  });

  it('leaves a nested swipe surface to its own swipe', () => {
    const main = surface();
    const panel = document.createElement('aside');
    panel.setAttribute('data-swipe-surface', 'x');
    const inPanel = document.createElement('div');
    panel.appendChild(inPanel);
    main.appendChild(panel);
    expect(swipeStartsOn(inPanel, main)).toBe(false);
    expect(swipeStartsOn(inPanel, panel)).toBe(true);
    main.remove();
  });

  // React bubbles a portal's events through the component tree: a touch in a
  // sheet portaled out of a message must not swipe the conversation.
  it('ignores a touch outside the surface element, such as in a portal', () => {
    const main = surface();
    const portaled = document.createElement('div');
    document.body.appendChild(portaled);
    expect(swipeStartsOn(portaled, main)).toBe(false);
    main.remove();
    portaled.remove();
  });

  it('leaves text fields alone', () => {
    const main = surface();
    const input = document.createElement('input');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const line = document.createElement('span');
    editor.appendChild(line);
    main.append(input, editor);
    expect(swipeStartsOn(input, main)).toBe(false);
    expect(swipeStartsOn(line, main)).toBe(false);
    main.remove();
  });

  it('ignores a target that is not an element', () => {
    const main = surface();
    expect(swipeStartsOn(null, main)).toBe(false);
    expect(swipeStartsOn(document, main)).toBe(false);
    main.remove();
  });
});
