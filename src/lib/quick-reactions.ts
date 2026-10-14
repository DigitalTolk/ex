// The long-press sheet leads with a row of one-tap reactions: the user's
// most-used emojis, topped up with a stock set so a new account still sees
// a full row. Shortcodes, as the frequent-emoji API returns them.
export const DEFAULT_QUICK_REACTIONS = [':thumbsup:', ':white_check_mark:', ':eyes:', ':tada:', ':heart:', ':joy:'];

export const QUICK_REACTION_COUNT = 6;

export function padQuickReactions(frequent: readonly string[] | undefined, count = QUICK_REACTION_COUNT): string[] {
  const list = (frequent ?? []).slice(0, count);
  for (const emoji of DEFAULT_QUICK_REACTIONS) {
    if (list.length >= count) break;
    if (!list.includes(emoji)) list.push(emoji);
  }
  return list;
}
