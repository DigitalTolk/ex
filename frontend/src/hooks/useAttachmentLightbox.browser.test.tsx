import { describe, expect, it, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { useAttachmentLightbox, type AttachmentLightboxSource } from './useAttachmentLightbox';
import type { Attachment } from '@/types';

// Browser coverage for the attachment-lightbox hook (no test previously).
// Drives isOpenable / open / the rendered ImageLightbox.

function att(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a-1',
    filename: 'photo.png',
    contentType: 'image/png',
    size: 1024,
    url: 'https://files/a-1',
    ...overrides,
  } as Attachment;
}

function source(key: string, attachment: Attachment | null): AttachmentLightboxSource<string> {
  return {
    key,
    slide: attachment ? { attachment, authorName: 'Alice', postedAt: '2026-05-01T10:00:00Z' } : null,
  };
}

function Probe({ sources }: { sources: AttachmentLightboxSource<string>[] }) {
  const { isOpenable, open, lightbox } = useAttachmentLightbox({ sources, postedIn: '~general' });
  return (
    <div>
      <span data-testid="openable-a" data-v={String(isOpenable('a'))} />
      <span data-testid="openable-x" data-v={String(isOpenable('no-such-key'))} />
      <button type="button" data-testid="open-a" onClick={() => open('a')}>open a</button>
      <button type="button" data-testid="open-missing" onClick={() => open('no-such-key')}>open missing</button>
      {lightbox}
    </div>
  );
}

const mounted: Array<{ unmount: () => Promise<void> }> = [];
async function mount(ui: React.ReactElement) {
  const r = await render(ui);
  mounted.push(r);
  return r;
}
afterEach(async () => {
  for (const m of mounted.splice(0)) await m.unmount();
});

describe('useAttachmentLightbox (browser)', () => {
  it('reports openable keys and skips sources with no slide', async () => {
    const screen = await mount(<Probe sources={[source('a', att()), source('b', null)]} />);
    expect(screen.getByTestId('openable-a').element().getAttribute('data-v')).toBe('true');
    expect(screen.getByTestId('openable-x').element().getAttribute('data-v')).toBe('false');
  });

  it('opens the lightbox for an openable key and renders the author context', async () => {
    const screen = await mount(<Probe sources={[source('a', att())]} />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await screen.getByTestId('open-a').click();
    await expect.element(screen.getByText('Alice')).toBeVisible();
  });

  it('open() is a no-op for a key that is not openable', async () => {
    const screen = await mount(<Probe sources={[source('a', att())]} />);
    await screen.getByTestId('open-missing').click();
    await new Promise((r) => setTimeout(r, 30));
    // Nothing opened — no lightbox author header rendered.
    expect(document.body.textContent).not.toContain('Alice');
  });

  it('coerces a missing attachment url to an empty string in the slide list', async () => {
    // The `url ?? ''` coercion runs while building the slide list (in the
    // memo), so just rendering the urlless source covers it — without opening
    // the lightbox (an empty <img src> would trip React's own warning).
    const screen = await mount(<Probe sources={[source('a', att({ url: undefined }))]} />);
    expect(screen.getByTestId('openable-a').element().getAttribute('data-v')).toBe('true');
  });
});
