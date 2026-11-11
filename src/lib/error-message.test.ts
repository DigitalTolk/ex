import { describe, it, expect } from 'vitest';
import { errorMessage } from './error-message';

describe('errorMessage', () => {
  it("uses an Error's message, and the fallback for anything else", () => {
    expect(errorMessage(new Error('that handle is taken'), 'Saving failed')).toBe('that handle is taken');
    expect(errorMessage('boom', 'Saving failed')).toBe('Saving failed');
  });
});
