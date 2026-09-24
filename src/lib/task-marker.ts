// Coding-task card marker — the backend posts
// "[task:<id>|<title>|<state>|<kind>|<project>]" as the root message of a
// task thread (plan-coding-agent.md) and rewrites it in place as the task
// moves; the chat renders it as a live TaskCard.

export interface TaskMarker {
  id: string;
  title: string;
  state: string;
  kind: string;
  project: string;
}

const MARKER_RE = /^\[task:([A-Za-z0-9]+)\|([^|\]]*)\|([^|\]]*)\|([^|\]]*)\|([^|\]]*)\]$/;

// parseTaskMarker recognizes a task card message body.
export function parseTaskMarker(body: string): TaskMarker | null {
  const m = MARKER_RE.exec(body.trim());
  if (!m) return null;
  return {
    id: m[1],
    title: m[2].trim() || 'Untitled task',
    state: m[3].trim() || 'created',
    kind: m[4].trim() || 'bug',
    project: m[5].trim(),
  };
}

// Kind flair — mirrors the backend's TaskKindFlair.
export function taskKindFlair(kind: string): { emoji: string; label: string } {
  switch (kind) {
    case 'feature':
      return { emoji: '✨', label: 'feature' };
    case 'chore':
      return { emoji: '🧹', label: 'chore' };
    default:
      return { emoji: '🐛', label: 'bug' };
  }
}

// Human labels for task states.
export function taskStateLabel(state: string): string {
  switch (state) {
    case 'created':
      return 'starting';
    case 'workspace_ready':
      return 'workspace ready';
    case 'in_progress':
      return 'in progress';
    case 'awaiting_user_test':
      return 'ready to test';
    case 'mr_created':
      return 'MR open';
    case 'done':
      return 'done';
    case 'setup_failed':
      return 'setup failed';
    case 'abandoned':
      return 'abandoned';
    default:
      return state.replace(/_/g, ' ');
  }
}

export function taskStateTerminal(state: string): boolean {
  return state === 'done' || state === 'abandoned';
}
