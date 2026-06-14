import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { useDeepLinkAnchor } from './useDeepLinkAnchor';

function Probe() {
  const a = useDeepLinkAnchor('ch-1');
  return (
    <div
      data-testid="anchor"
      data-main={a.mainAnchor ?? ''}
      data-thread={a.threadAnchor ?? ''}
      data-param={a.threadParam ?? ''}
    />
  );
}

async function at(path: string) {
  await render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
    </MemoryRouter>,
  );
  const el = document.querySelector('[data-testid="anchor"]') as HTMLElement;
  return {
    main: el.getAttribute('data-main'),
    thread: el.getAttribute('data-thread'),
    param: el.getAttribute('data-param'),
  };
}

describe('useDeepLinkAnchor (browser)', () => {
  it('parses #msg-X into mainAnchor', async () => {
    expect(await at('/channel/x#msg-abc')).toMatchObject({ main: 'abc', thread: '' });
  });

  it('ignores a non-msg hash', async () => {
    expect(await at('/channel/x#elsewhere')).toMatchObject({ main: '', thread: '' });
  });

  it('returns nothing when there is no hash', async () => {
    expect(await at('/channel/x')).toMatchObject({ main: '', thread: '' });
  });

  it('treats an empty "#msg-" as no anchor', async () => {
    expect(await at('/channel/x#msg-')).toMatchObject({ main: '', thread: '' });
  });

  it('promotes ?thread=R to mainAnchor and #msg-Y to threadAnchor', async () => {
    expect(await at('/channel/x?thread=root-1#msg-reply-1')).toMatchObject({
      main: 'root-1',
      thread: 'reply-1',
      param: 'root-1',
    });
  });

  it('with ?thread=R and no hash, threadAnchor is empty', async () => {
    expect(await at('/channel/x?thread=root-2')).toMatchObject({ main: 'root-2', thread: '', param: 'root-2' });
  });

  it('with the hash equal to the thread root, threadAnchor stays empty', async () => {
    expect(await at('/channel/x?thread=root-3#msg-root-3')).toMatchObject({ main: 'root-3', thread: '' });
  });
});
