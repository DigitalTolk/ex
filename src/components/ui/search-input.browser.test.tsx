import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { UserPlus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';

// GEOMETRY, not markup. The bug this guards against — the search glyph sitting
// on top of the placeholder on a phone — is invisible to every assertion about
// which classes are present, because the class WAS present: the Input base
// carries `mobile:px-4`, and a variant utility outranks a plain `pl-9` no
// matter what order the two are passed in. Only the resolved box shows it.

function textStart(container: HTMLElement) {
  const input = container.querySelector('input')!;
  const icon = container.querySelector('svg')!;
  const inputRect = input.getBoundingClientRect();
  const iconRect = icon.getBoundingClientRect();
  return {
    // Where the caret/placeholder begins, in viewport coordinates.
    caret: inputRect.left + parseFloat(getComputedStyle(input).paddingLeft),
    iconRight: iconRect.right,
  };
}

describe('SearchInput', () => {
  it('never lets the leading glyph reach the text, on any tier', async () => {
    const screen = await render(
      <div style={{ width: 320 }}>
        <SearchInput aria-label="Search things" placeholder="Search..." />
      </div>,
    );
    const { caret, iconRight } = textStart(screen.container as HTMLElement);
    expect(iconRight).toBeLessThanOrEqual(caret);
  });

  it('keeps the same clearance with a caller-supplied glyph', async () => {
    const screen = await render(
      <div style={{ width: 320 }}>
        <SearchInput icon={UserPlus} aria-label="Add member" placeholder="Add someone..." />
      </div>,
    );
    const { caret, iconRight } = textStart(screen.container as HTMLElement);
    expect(iconRight).toBeLessThanOrEqual(caret);
  });

  it('forwards container and input classes to the right elements', async () => {
    const screen = await render(
      <SearchInput containerClassName="mb-4 w-full" className="h-9" aria-label="Search things" />,
    );
    const input = screen.getByLabelText('Search things').element() as HTMLInputElement;
    expect(input.className).toContain('h-9');
    expect(input.parentElement!.className).toContain('mb-4');
    expect(input.parentElement!.className).toContain('relative');
  });

  // Pins the precedence rule itself, so the trap is documented by a failing
  // test rather than by a comment someone has to remember to read. A plain
  // `pl-9` is the natural thing to write and it silently collapses on mobile.
  it('resolves a bare pl-9 to the base mobile padding on the mobile tier', async () => {
    const screen = await render(<Input className="pl-9" aria-label="raw" />);
    const el = screen.getByLabelText('raw').element() as HTMLInputElement;
    const padding = parseFloat(getComputedStyle(el).paddingLeft);
    const mobile = document.documentElement.classList.contains('tier-mobile');
    expect(padding).toBe(mobile ? 16 : 36);
  });
});
