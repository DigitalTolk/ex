// Validation caps mirrored from the Go backend (internal/service/limits.go).
// Keep these constants in sync — the backend is authoritative; the frontend
// pre-checks here are for fast feedback in the UI before a round-trip.

export const MAX_MESSAGE_BODY_CHARS = 4096;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_CHANNEL_NAME_LEN = 32;
export const MAX_CHANNEL_DESCRIPTION_LEN = 255;
export const MAX_DISTINCT_REACTIONS = 16;

// CHANNEL_NAME_PATTERN is the slug-style identifier the backend accepts.
// Lowercase ASCII letters, digits, hyphen — no leading/trailing hyphens
// and no double hyphens.
export const CHANNEL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// countCodepoints returns the number of Unicode codepoints in the string.
// `string.length` counts UTF-16 code units, which over-counts emoji and
// astral-plane characters. We use the spread iterator which yields one
// element per codepoint — matching the backend's utf8.RuneCountInString.
export function countCodepoints(s: string): number {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of s) n++;
  return n;
}

export interface ChannelNameError {
  kind: 'too-long' | 'invalid';
  message: string;
}

// validateChannelName mirrors the backend rule. Returns null when valid.
export function validateChannelName(name: string): ChannelNameError | null {
  if (countCodepoints(name) > MAX_CHANNEL_NAME_LEN) {
    return {
      kind: 'too-long',
      message: `Name must be ${MAX_CHANNEL_NAME_LEN} characters or fewer.`,
    };
  }
  if (name.length === 0) return null; // empty handled separately by required-field UX
  if (!CHANNEL_NAME_PATTERN.test(name)) {
    return {
      kind: 'invalid',
      message:
        'Use lowercase letters, digits, and hyphens only (e.g. "team-1"). No spaces or special characters.',
    };
  }
  return null;
}

export function validateChannelDescription(desc: string): string | null {
  if (countCodepoints(desc) > MAX_CHANNEL_DESCRIPTION_LEN) {
    return `Description must be ${MAX_CHANNEL_DESCRIPTION_LEN} characters or fewer.`;
  }
  return null;
}
