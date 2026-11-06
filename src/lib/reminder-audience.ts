// ReminderAudience is who a reminder is for besides its owner: the people
// added, or everyone in the chat but the few left out. Both lists are kept
// while the choice is switched in the picker, so switching back loses nothing.
export interface ReminderAudience {
  everyone: boolean;
  userIDs: string[];
  excludedUserIDs: string[];
}

export const NOBODY_ELSE: ReminderAudience = { everyone: false, userIDs: [], excludedUserIDs: [] };
export const EVERYONE: ReminderAudience = { everyone: true, userIDs: [], excludedUserIDs: [] };
