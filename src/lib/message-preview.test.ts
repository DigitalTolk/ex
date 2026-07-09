import { describe, it, expect } from 'vitest';
import { toPlainTextPreview } from './message-preview';

describe('toPlainTextPreview', () => {
  it('flattens user mentions to @DisplayName', () => {
    expect(toPlainTextPreview('hi @[u-1|Alice]')).toBe('hi @Alice');
  });

  it('flattens channel mentions to ~slug', () => {
    expect(toPlainTextPreview('see ~[ch-1|general]')).toBe('see ~general');
  });

  it('renders a known emoji shortcode to its glyph', () => {
    expect(toPlainTextPreview('done :tada:')).toBe('done 🎉');
  });

  it('renders a canonical-name emoji (frontend remap, e.g. :thinking:)', () => {
    expect(toPlainTextPreview(':thinking:')).toBe('🤔');
  });

  it('renders a toned emoji as the base glyph', () => {
    expect(toPlainTextPreview(':thumbsup::skin-tone-3:')).toBe('👍');
  });

  it('leaves unknown/custom shortcodes untouched', () => {
    expect(toPlainTextPreview('love :my_custom_logo:')).toBe('love :my_custom_logo:');
  });

  it('collapses whitespace and newlines and trims', () => {
    expect(toPlainTextPreview('a\n\n  b   c ')).toBe('a b c');
  });

  it('combines mentions and emoji', () => {
    expect(toPlainTextPreview('@[u|Ann] ~[c|ops] :wave:')).toBe('@Ann ~ops 👋');
  });

  it('returns an empty string for a blank body', () => {
    expect(toPlainTextPreview('   \n  ')).toBe('');
  });
});
