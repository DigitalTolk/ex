// The product rules shared by every mobile swipe — the right-hand panels and
// bottom sheets dismissed by a swipe, and the channel list a conversation
// slides off to reveal. Recognition is @use-gesture/react's and motion is
// Motion's (see hooks/useAxisSwipe); what's left here is the decision: where a
// swipe may start and whether a release goes through. Pure, so it's tested
// without a finger.

// The one spring every swipe settles with. A release hands it the finger's
// speed, so the surface carries on from where it was let go instead of
// restarting from a standstill.
export const SWIPE_SPRING = { type: 'spring' as const, stiffness: 600, damping: 45 };

// Marks an element as a swipe surface. A touch belongs to the innermost one,
// so a thread panel inside the conversation swipes the panel, not the
// conversation behind it. `x` surfaces move sideways and keep vertical
// scrolling native (see the touch-action rule in index.css); `y` surfaces
// are the bottom sheets.
export const SWIPE_SURFACE_ATTR = 'data-swipe-surface';

// Where a swipe may begin on `surface`. Not in a portal rendered from inside
// it (React bubbles a portal's events through the component tree, so the
// emoji sheet of a message reaches the conversation's handlers), not inside
// a nested swipe surface, and not in a text field, where a drag selects text
// or moves the caret. Content that scrolls sideways (a code block, a table)
// needs no rule here: it keeps its native sideways pan, and the browser
// takes such a touch over before the swipe could claim it.
export function swipeStartsOn(target: EventTarget | null, surface: Element): boolean {
  if (!(target instanceof Element) || !surface.contains(target)) return false;
  if (target.closest(`[${SWIPE_SURFACE_ATTR}]`) !== surface) return false;
  return !target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}

// How far ahead of where it was let go a release is judged, in seconds of its
// own speed: a flick goes further than its last position, a finger coming to
// rest goes nowhere, and one heading back is taken back.
const RELEASE_PROJECTION_S = 0.2;
// How much of the way the projected release must reach to go through, within
// bounds, so a full-screen panel doesn't need a long drag and a small sheet
// isn't dismissed by a nudge.
const COMMIT_FRACTION = 0.35;
const COMMIT_MIN_PX = 64;
const COMMIT_MAX_PX = 160;

// shouldCommitSwipe decides a release. `distance` is how far the surface has
// moved towards where the swipe takes it, `velocity` its speed that way in
// px/s (negative while heading back), `travel` the whole way there. A slow,
// deliberate drag commits on distance alone; a flick commits early.
export function shouldCommitSwipe({
  distance,
  velocity,
  travel,
}: {
  distance: number;
  velocity: number;
  travel: number;
}): boolean {
  const needed = Math.min(COMMIT_MAX_PX, Math.max(COMMIT_MIN_PX, travel * COMMIT_FRACTION));
  return distance + velocity * RELEASE_PROJECTION_S >= needed;
}
