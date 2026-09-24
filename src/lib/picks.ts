// Pick tokens: the "/name" grammar shared by connector picks (/gitlab) and
// skill picks (/weekly-report) in agent invocations.

// skillPickToken mirrors the server's skillToken normalization: a skill's
// display name → its /pick token ("Weekly Report" → "weekly-report").
export function skillPickToken(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
