import { describe, expect, it, vi } from 'vitest';
import { trackScrolledOffTop } from './scroll-fade';

function scroller({ scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight });
  el.scrollTop = scrollTop;
  Object.defineProperty(el, 'scrollTop', { value: scrollTop });
  return el;
}

describe('trackScrolledOffTop', () => {
  it('reports the list moving off its top, and back', () => {
    const set = vi.fn();
    const onScroll = trackScrolledOffTop(set);
    onScroll({ target: scroller({ scrollHeight: 900, clientHeight: 300, scrollTop: 40 }) });
    onScroll({ target: scroller({ scrollHeight: 900, clientHeight: 300, scrollTop: 0 }) });
    expect(set.mock.calls).toEqual([[true], [false]]);
  });

  // The Activity filter tabs scroll sideways on a phone, inside the same
  // wrapper: their scroll events must not switch the list's fade off.
  it('ignores a scroller inside that only scrolls sideways', () => {
    const set = vi.fn();
    trackScrolledOffTop(set)({ target: scroller({ scrollHeight: 48, clientHeight: 48, scrollTop: 0 }) });
    expect(set).not.toHaveBeenCalled();
  });
});
