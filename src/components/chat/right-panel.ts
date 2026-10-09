// RIGHT_PANEL_COVER_CLASS lays out a right-hand panel (thread, members, the
// side panel) that sits beside the conversation on a wide window but covers it
// below the header when there's no room: as a fixed sheet on a phone, and
// inside the main area on a desktop window narrower than 768px (`narrow:`),
// instead of squeezing the conversation.
export const RIGHT_PANEL_COVER_CLASS =
  'mobile:fixed narrow:not-mobile:absolute narrow:inset-x-0 narrow:bottom-0 narrow:top-[var(--mobile-right-panel-top,6rem)] narrow:z-40 narrow:w-auto narrow:border-l-0';
