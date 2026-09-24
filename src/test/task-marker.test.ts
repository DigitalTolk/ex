import { describe, it, expect } from 'vitest';
import {
  parseTaskMarker,
  taskKindFlair,
  taskStateLabel,
  taskStateTerminal,
} from '@/lib/task-marker';

describe('parseTaskMarker', () => {
  it('parses a full marker into its fields', () => {
    expect(parseTaskMarker('[task:T123abc|Fix login flow|in_progress|feature|senso]')).toEqual({
      id: 'T123abc',
      title: 'Fix login flow',
      state: 'in_progress',
      kind: 'feature',
      project: 'senso',
    });
  });

  it('tolerates surrounding whitespace in the body', () => {
    expect(parseTaskMarker('  [task:a1|T|done|bug|p]  ')?.id).toBe('a1');
  });

  it('returns null for a non-marker body', () => {
    expect(parseTaskMarker('hello world')).toBeNull();
    expect(parseTaskMarker('[task:not/valid|a|b|c|d]')).toBeNull();
    // Wrong arity — the card format is exactly five fields.
    expect(parseTaskMarker('[task:a1|only|three|fields]')).toBeNull();
  });

  it('fills defaults for empty title/state/kind and keeps empty project', () => {
    expect(parseTaskMarker('[task:a1||||]')).toEqual({
      id: 'a1',
      title: 'Untitled task',
      state: 'created',
      kind: 'bug',
      project: '',
    });
  });

  it('treats whitespace-only segments as empty (trimmed before defaulting)', () => {
    const m = parseTaskMarker('[task:a1| | | | ]');
    expect(m).toEqual({
      id: 'a1',
      title: 'Untitled task',
      state: 'created',
      kind: 'bug',
      project: '',
    });
  });
});

describe('taskKindFlair', () => {
  it('maps feature', () => {
    expect(taskKindFlair('feature')).toEqual({ emoji: '✨', label: 'feature' });
  });

  it('maps chore', () => {
    expect(taskKindFlair('chore')).toEqual({ emoji: '🧹', label: 'chore' });
  });

  it('defaults everything else to bug', () => {
    expect(taskKindFlair('bug')).toEqual({ emoji: '🐛', label: 'bug' });
    expect(taskKindFlair('unknown-kind')).toEqual({ emoji: '🐛', label: 'bug' });
  });
});

describe('taskStateLabel', () => {
  it('labels every known state', () => {
    expect(taskStateLabel('created')).toBe('starting');
    expect(taskStateLabel('workspace_ready')).toBe('workspace ready');
    expect(taskStateLabel('in_progress')).toBe('in progress');
    expect(taskStateLabel('awaiting_user_test')).toBe('ready to test');
    expect(taskStateLabel('mr_created')).toBe('MR open');
    expect(taskStateLabel('done')).toBe('done');
    expect(taskStateLabel('setup_failed')).toBe('setup failed');
    expect(taskStateLabel('abandoned')).toBe('abandoned');
  });

  it('humanizes unknown states by swapping underscores for spaces', () => {
    expect(taskStateLabel('code_review_pending')).toBe('code review pending');
  });
});

describe('taskStateTerminal', () => {
  it('done and abandoned are terminal', () => {
    expect(taskStateTerminal('done')).toBe(true);
    expect(taskStateTerminal('abandoned')).toBe(true);
  });

  it('active states are not terminal', () => {
    expect(taskStateTerminal('in_progress')).toBe(false);
  });
});
