// A deactivated account: switched off by an admin, or disabled or deleted in
// the employee directory. Its messages stay, but nobody can mention it, add
// it to a channel or start a conversation with it, and lists show it last.
export function isDeactivated(user: { status?: string }): boolean {
  return user.status === 'deactivated';
}

// The people a picker may offer: everyone but deactivated accounts.
export function withoutDeactivated<T extends { status?: string }>(users: T[]): T[] {
  return users.filter((u) => !isDeactivated(u));
}

// Active accounts first, deactivated ones after, each group in its given
// order.
export function deactivatedLast<T extends { status?: string }>(users: T[]): T[] {
  return [...withoutDeactivated(users), ...users.filter(isDeactivated)];
}
