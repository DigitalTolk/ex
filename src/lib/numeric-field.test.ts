import { describe, expect, it } from 'vitest';
import { wholeNumberField } from './numeric-field';

describe('wholeNumberField', () => {
  it('keeps the digits of what was typed', () => {
    expect(wholeNumberField('12', 1)).toBe('12');
    expect(wholeNumberField('1a2', 1)).toBe('12');
    expect(wholeNumberField('1.5', 1)).toBe('15');
  });

  it('leaves an emptied field empty', () => {
    expect(wholeNumberField('', 1)).toBe('');
    expect(wholeNumberField('abc', 1)).toBe('');
  });

  it('clamps into the range', () => {
    expect(wholeNumberField('0', 1, 50)).toBe('1');
    expect(wholeNumberField('99', 1, 50)).toBe('50');
    expect(wholeNumberField('9'.repeat(40), 1)).toBe('999999999999999');
  });
});
