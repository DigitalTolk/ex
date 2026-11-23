import { describe, it, expect } from 'vitest';
import { nameClash } from './emoji-names';

describe('nameClash', () => {
  it('names a standard emoji or a taken custom name, and nothing else', () => {
    expect(nameClash('', [])).toBeNull();
    expect(nameClash('smile', [])).toBe(':smile: is already a standard emoji. Pick another name.');
    expect(nameClash('thumbsup', undefined)).toBe(':thumbsup: is already a standard emoji. Pick another name.');
    expect(nameClash('partyparrot', [{ name: 'partyparrot' }])).toBe("There's already a custom emoji called :partyparrot:. Pick another name.");
    expect(nameClash('partyparrot', [{ name: 'other' }])).toBeNull();
    expect(nameClash('partyparrot', undefined)).toBeNull();
  });
});
