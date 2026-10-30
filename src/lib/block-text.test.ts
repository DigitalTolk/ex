import { describe, expect, it } from 'vitest';
import { expandDateTokens, formatTallyTime, hasBlocks } from './block-text';

const AT = 1761058323; // 2025-10-21T14:52:03Z
const at = new Date(AT * 1000);
const local = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, opts).format(at);

describe('hasBlocks', () => {
  it('sees blocks on the message or inside any of its cards', () => {
    expect(hasBlocks({})).toBe(false);
    expect(hasBlocks({ blocks: [], messageAttachments: [{ text: 'card' }] })).toBe(false);
    expect(hasBlocks({ blocks: [{ type: 'divider', block_id: 'b1' }] })).toBe(true);
    expect(hasBlocks({ messageAttachments: [{ text: 'a' }, { blocks: [{ type: 'divider', block_id: 'b1' }] }] })).toBe(true);
  });
});

describe('expandDateTokens', () => {
  it('leaves text without tokens untouched', () => {
    expect(expandDateTokens('Reviewed at 14:52')).toBe('Reviewed at 14:52');
  });

  it("shows each part of a token in the viewer's zone and locale", () => {
    expect(expandDateTokens(`Reviewed at <!date^${AT}^{time}|14:52 UTC>`)).toBe(
      `Reviewed at ${local({ hour: 'numeric', minute: '2-digit' })}`,
    );
    expect(expandDateTokens(`<!date^${AT}^{date_short} · {date} · {date_long}>`)).toBe(
      [
        local({ month: 'short', day: 'numeric' }),
        local({ month: 'long', day: 'numeric', year: 'numeric' }),
        local({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
      ].join(' · '),
    );
    // Formatters are reused: a second pass reads the same.
    expect(expandDateTokens(`<!date^${AT}^{time}>`)).toBe(local({ hour: 'numeric', minute: '2-digit' }));
  });

  it('falls back when a token names a part this client can not show', () => {
    expect(expandDateTokens(`At <!date^${AT}^{ago}|yesterday>`)).toBe('At yesterday');
    // Without a fallback the token stays as the app wrote it.
    expect(expandDateTokens(`At <!date^${AT}^{ago}>`)).toBe(`At <!date^${AT}^{ago}>`);
    // Not a token at all.
    expect(expandDateTokens('<!date^soon^{time}>')).toBe('<!date^soon^{time}>');
  });
});

describe('formatTallyTime', () => {
  it('shows the time alone today and the date before that', () => {
    const time = local({ hour: 'numeric', minute: '2-digit' });
    expect(formatTallyTime(at.toISOString(), new Date(at.getTime() + 60_000))).toBe(time);
    expect(formatTallyTime(at.toISOString(), new Date(at.getTime() + 3 * 86_400_000))).toBe(
      `${local({ month: 'short', day: 'numeric' })}, ${time}`,
    );
  });
});
