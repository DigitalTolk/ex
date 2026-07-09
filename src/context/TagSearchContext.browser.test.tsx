import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { TagSearchProvider, useTagOpen, useTagState } from './TagSearchContext';

// Browser-gate coverage for the split tag-search contexts: the real provider
// (openTag bumps the nonce on every call — even re-clicks of the same tag —
// and closeTag clears the tag but keeps the nonce) plus the no-provider
// fallbacks, which must be inert rather than crash consumers rendered
// outside a provider (e.g. MessageItem in the pinned panel).

afterEach(() => cleanup());

function Consumer() {
  const { openTag } = useTagOpen();
  const { activeTag, tagNonce, closeTag } = useTagState();
  return (
    <div>
      <button data-testid="tag-open" onClick={() => openTag('release')} />
      <button data-testid="tag-close" onClick={() => closeTag()} />
      <span data-testid="tag-state">{`${activeTag ?? ''}:${tagNonce}`}</span>
    </div>
  );
}

const state = () => document.querySelector('[data-testid="tag-state"]')?.textContent;
const click = (id: string) =>
  (document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click();

describe('TagSearchContext', () => {
  it('openTag sets the tag and bumps the nonce per call; closeTag clears the tag, keeps the nonce', async () => {
    const screen = await render(
      <TagSearchProvider>
        <Consumer />
      </TagSearchProvider>,
    );
    expect(state()).toBe(':0');
    click('tag-open');
    await expect.element(screen.getByTestId('tag-state')).toHaveTextContent('release:1');
    // A re-click of the SAME tag still bumps the nonce so consumers refetch.
    click('tag-open');
    await expect.element(screen.getByTestId('tag-state')).toHaveTextContent('release:2');
    click('tag-close');
    await expect.element(screen.getByTestId('tag-state')).toHaveTextContent(':2');
  });

  it('honors an initialTag on mount', async () => {
    const screen = await render(
      <TagSearchProvider initialTag="incidents">
        <Consumer />
      </TagSearchProvider>,
    );
    await expect.element(screen.getByTestId('tag-state')).toHaveTextContent('incidents:0');
  });

  it('is inert (no crash, no state) when consumed without a provider', async () => {
    const screen = await render(<Consumer />);
    click('tag-open');
    click('tag-close');
    // The noop fallbacks swallow both calls; nothing changes and nothing throws.
    await expect.element(screen.getByTestId('tag-state')).toHaveTextContent(':0');
  });
});
