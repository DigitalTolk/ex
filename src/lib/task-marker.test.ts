import { describe, expect, it } from 'vitest';

import { parseTaskMarker, taskKindFlair, taskStateLabel, taskStateTerminal } from './task-marker';

describe('task marker', () => {
  it('parses the backend card marker', () => {
    expect(parseTaskMarker('[task:01ABC|Fix Feb-29 crash|awaiting_user_test|bug|dt/booking-portal]')).toEqual({
      id: '01ABC',
      title: 'Fix Feb-29 crash',
      state: 'awaiting_user_test',
      kind: 'bug',
      project: 'dt/booking-portal',
    });
  });

  it('tolerates surrounding whitespace and fills defaults', () => {
    expect(parseTaskMarker('  [task:X|||feature|g/r]  ')).toEqual({
      id: 'X',
      title: 'Untitled task',
      state: 'created',
      kind: 'feature',
      project: 'g/r',
    });
  });

  it('rejects non-markers and artifact markers', () => {
    expect(parseTaskMarker('hello [task:1|a|b|c|d]')).toBeNull();
    expect(parseTaskMarker('[artifact:r:a|t|k|12]')).toBeNull();
    expect(parseTaskMarker('[task:1|a|b]')).toBeNull();
  });

  it('renders flair and labels', () => {
    expect(taskKindFlair('feature')).toEqual({ emoji: '✨', label: 'feature' });
    expect(taskKindFlair('weird')).toEqual({ emoji: '🐛', label: 'bug' });
    expect(taskStateLabel('awaiting_user_test')).toBe('ready to test');
    expect(taskStateTerminal('done')).toBe(true);
    expect(taskStateTerminal('in_progress')).toBe(false);
  });
});
