import { afterEach, describe, expect, it, vi } from 'vitest';
import * as highlighter from './code-highlight';
import {
  getHighlighter,
  highlightedCode,
  highlighterImport,
  loadHighlighter,
  resetCodeHighlightForTests,
  subscribeHighlighter,
} from './code-highlight-loader';

afterEach(() => {
  resetCodeHighlightForTests();
});

describe('code-highlight-loader', () => {
  it('loads the highlighter once however many blocks ask, and tells the subscribers', async () => {
    const load = vi.fn(() => Promise.resolve(highlighter));
    highlighterImport.load = load;
    const listener = vi.fn();
    const unsubscribe = subscribeHighlighter(listener);
    loadHighlighter();
    loadHighlighter();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(getHighlighter()).toBe(highlighter));
    expect(listener).toHaveBeenCalledTimes(1);
    loadHighlighter();
    expect(load).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('gives nothing for code the grammar cannot highlight', () => {
    expect(highlightedCode(highlighter, 'plain', 'no-such-language')).toBeNull();
  });

  it('keeps the most recently shown 200 blocks', () => {
    const mod = { ...highlighter, highlightToHast: vi.fn(highlighter.highlightToHast) };
    for (let i = 0; i < 201; i++) highlightedCode(mod, `const n${i} = ${i};`, 'js');
    expect(mod.highlightToHast).toHaveBeenCalledTimes(201);
    // The newest are still cached; the oldest was let go.
    highlightedCode(mod, 'const n200 = 200;', 'js');
    expect(mod.highlightToHast).toHaveBeenCalledTimes(201);
    highlightedCode(mod, 'const n0 = 0;', 'js');
    expect(mod.highlightToHast).toHaveBeenCalledTimes(202);
  });
});
